import { execa } from "execa"
import type { PullRequest, Repository, Run } from "../types.js"
import type { CiProvider } from "./types.js"

/**
 * The one way this provider reaches the outside world. A seam, so tests can
 * exercise it without a network or a `gh` binary.
 */
export type CommandRunner = (
  file: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string }>

const runWithExeca: CommandRunner = async (file, args, options) => {
  const { stdout } = await execa(file, args, options)
  return { stdout }
}

// Every read left here: pull requests and the repo listing. CI runs and jobs
// are read by the poller (src/poller), not by this provider.
const READ_TIMEOUT_MS = 30_000

/**
 * The pane's GitHub side: cancel, rerun and logs for a run, plus pull
 * requests and repository listing.
 */
export class GitHubProvider implements CiProvider {
  readonly name = "github"

  constructor(private readonly run: CommandRunner = runWithExeca) {}

  async listRepositories(org?: string): Promise<Repository[]> {
    try {
      const args = ["repo", "list", "--json", "name,owner", "--limit", "100"]
      if (org) {
        args.push(org)
      }

      const { stdout } = await this.run("gh", args, { timeout: READ_TIMEOUT_MS })
      const repos = JSON.parse(stdout)

      return repos.map((repo: { owner: { login: string }; name: string }) => ({
        owner: repo.owner.login,
        name: repo.name,
        fullName: `${repo.owner.login}/${repo.name}`,
      }))
    } catch (error) {
      // Check if it's a rate limit error
      if (error instanceof Error && error.message?.includes("API rate limit exceeded")) {
        throw new Error("GitHub API rate limit exceeded. Please wait before trying again.")
      }
      // Silently fail for now, could log to file if needed
      return []
    }
  }

  async cancel(run: Run): Promise<void> {
    await this.run("gh", ["run", "cancel", run.id, "-R", run.repo.fullName], { timeout: 10000 })
  }

  async rerun(run: Run): Promise<void> {
    await this.run("gh", ["run", "rerun", run.id, "-R", run.repo.fullName], { timeout: 10000 })
  }

  async logs(run: Run): Promise<string> {
    // `gh run view --log` downloads and unzips the whole log archive, which on a
    // large run takes appreciably longer than a plain API read.
    const { stdout } = await this.run(
      "gh",
      ["run", "view", run.id, "-R", run.repo.fullName, "--log"],
      {
        timeout: 60000,
      },
    )
    return stdout
  }

  async listPullRequests(repo: string, limit = 20): Promise<PullRequest[]> {
    try {
      const { stdout } = await this.run(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--limit",
          limit.toString(),
          "--json",
          "id,number,title,state,isDraft,headRefName,baseRefName,url,createdAt,updatedAt,author,statusCheckRollup,reviewDecision,mergeable",
        ],
        { timeout: READ_TIMEOUT_MS },
      )

      const prs = JSON.parse(stdout)
      const [owner, name] = repo.split("/")

      const pullRequests: PullRequest[] = prs.map(
        (pr: {
          id: string
          number: number
          title: string
          state?: string
          isDraft?: boolean
          headRefName: string
          baseRefName: string
          url: string
          createdAt: string
          updatedAt: string
          author?: { login: string }
          statusCheckRollup?: { state: string }
          reviewDecision?: string
          mergeable?: string
        }) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state?.toLowerCase() || "open",
          draft: pr.isDraft || false,
          user: {
            login: pr.author?.login || "unknown",
          },
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          url: pr.url,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          repository: { owner, name },
          statusCheckRollup: pr.statusCheckRollup
            ? { state: pr.statusCheckRollup.state }
            : undefined,
          reviewDecision: pr.reviewDecision,
          mergeable: pr.mergeable,
          isDraft: pr.isDraft,
        }),
      )

      return pullRequests
    } catch (error) {
      // Check if it's a rate limit error
      if (error instanceof Error && error.message?.includes("API rate limit exceeded")) {
        throw new Error("GitHub API rate limit exceeded. Please wait before trying again.")
      }
      // Return empty array on error (silently fail)
      return []
    }
  }

  async getAllPullRequests(repos: string[]): Promise<PullRequest[]> {
    const allPRs: PullRequest[] = []

    for (const repo of repos) {
      const prs = await this.listPullRequests(repo)
      allPRs.push(...prs)
    }

    // Sort by creation time (most recent first) for stable chronological ordering
    return allPRs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }
}

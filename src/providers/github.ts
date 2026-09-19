import { execa } from "execa"
import type { Job, PullRequest, Repository, Run } from "../types.js"
import {
  type GitHubJobPayload,
  type GitHubRunPayload,
  mapGitHubJob,
  mapGitHubRun,
} from "./github-map.js"
import type { CiProvider, FetchResult, ProviderDiagnostic, Scope } from "./types.js"

/**
 * The one way this provider reaches the outside world. A seam, so tests can
 * exercise the mapping and the diagnostics without a network or a `gh` binary.
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

// Every read: runs, jobs, older runs, pull requests, the repo listing. The runs
// call is usually under a second, but it is a ~270KB page, and a 10s ceiling
// turned "slow" into "could not list runs".
const READ_TIMEOUT_MS = 30_000

/** The fields execa adds to the errors it throws, all optional. */
interface CommandError {
  timedOut?: boolean
  stderr?: string
  code?: string
  shortMessage?: string
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 120) ?? ""

/** Why a `gh` call failed, in a few words — the part "could not list runs" left out. */
function describeFailure(error: unknown): string {
  if (error instanceof SyntaxError) return "unreadable response"
  const e = (error ?? {}) as CommandError & { message?: string }
  if (e.timedOut) {
    const ms = /after (\d+) milliseconds/.exec(e.shortMessage ?? e.message ?? "")?.[1]
    return ms ? `timed out after ${Number(ms) / 1000}s` : "timed out"
  }
  if (e.code === "ENOENT") return "gh is not installed or not on PATH"
  return firstLine(e.stderr ?? "") || firstLine(e.shortMessage ?? e.message ?? String(error))
}

export class GitHubProvider implements CiProvider {
  readonly name = "github"

  private cache: Map<string, { data: unknown; timestamp: number }> = new Map()
  private cacheTimeout = 5000 // 5 seconds
  private limit = 20

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

  async fetchRuns(scope: Scope): Promise<FetchResult> {
    const runs: Run[] = []
    const diagnostics: ProviderDiagnostic[] = []

    for (const repo of scope.repositories) {
      const cacheKey = `runs:${repo}`
      const cached = this.getFromCache<Run[]>(cacheKey)
      if (cached) {
        runs.push(...cached)
        continue
      }
      try {
        const { stdout } = await this.run(
          "gh",
          ["api", `repos/${repo}/actions/runs?per_page=${this.limit}`],
          { timeout: READ_TIMEOUT_MS },
        )
        const payload = JSON.parse(stdout) as { workflow_runs: GitHubRunPayload[] }
        const mapped = (payload.workflow_runs ?? []).map(mapGitHubRun)
        this.setCache(cacheKey, mapped)
        runs.push(...mapped)
      } catch (error) {
        diagnostics.push(this.diagnose(error, `GitHub: could not list runs for ${repo}`))
      }
    }

    runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return { runs, diagnostics }
  }

  async fetchJobs(run: Run): Promise<Job[]> {
    const repo = run.repo.fullName
    const cacheKey = `jobs:${repo}:${run.id}`
    const cached = this.getFromCache<Job[]>(cacheKey)
    if (cached) return cached

    try {
      // The API, not `gh run view`, because only the API reports the runner.
      const { stdout } = await this.run(
        "gh",
        ["api", `repos/${repo}/actions/runs/${run.id}/jobs`],
        {
          timeout: READ_TIMEOUT_MS,
        },
      )

      const payload = JSON.parse(stdout) as { jobs?: GitHubJobPayload[] }
      const jobs = (payload.jobs ?? []).map((raw) => mapGitHubJob(raw, run.key))

      this.setCache(cacheKey, jobs)
      return jobs
    } catch (_error) {
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

  /**
   * Runs older than `before`, for the resurrect key. Deliberately uncached:
   * the cache is keyed by repository, and a page of older runs must not
   * displace the page of current ones the grid is built from.
   */
  async fetchOlderRuns(scope: Scope, before: string, limit = 1): Promise<FetchResult> {
    const runs: Run[] = []
    const diagnostics: ProviderDiagnostic[] = []

    for (const repo of scope.repositories) {
      try {
        const created = encodeURIComponent(`<${before}`)
        const { stdout } = await this.run(
          "gh",
          ["api", `repos/${repo}/actions/runs?per_page=${limit}&created=${created}`],
          { timeout: READ_TIMEOUT_MS },
        )
        const payload = JSON.parse(stdout) as { workflow_runs: GitHubRunPayload[] }
        runs.push(...(payload.workflow_runs ?? []).map(mapGitHubRun))
      } catch (error) {
        // Say so: "no older runs" and "could not look" must not read alike.
        diagnostics.push(this.diagnose(error, `GitHub: could not list older runs for ${repo}`))
      }
    }

    runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return { runs: runs.slice(0, limit), diagnostics }
  }

  /**
   * A rate limit is worth naming on its own — GitHub words its primary and
   * secondary limits differently. Anything else is reported against the repo,
   * with the cause.
   */
  private diagnose(error: unknown, fallback: string): ProviderDiagnostic {
    const e = (error ?? {}) as CommandError & { message?: string }
    const text = `${e.message ?? String(error)}\n${e.stderr ?? ""}`
    return {
      provider: "github",
      level: "error",
      message: /rate limit/i.test(text)
        ? "GitHub: API rate limit exceeded"
        : `${fallback} — ${describeFailure(error)}`,
    }
  }

  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null

    const now = Date.now()
    if (now - cached.timestamp > this.cacheTimeout) {
      this.cache.delete(key)
      return null
    }

    return cached.data as T
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    })
  }

  clearCache(): void {
    this.cache.clear()
  }

  async listPullRequests(repo: string, limit = 20): Promise<PullRequest[]> {
    const cacheKey = `prs:${repo}`
    const cached = this.getFromCache<PullRequest[]>(cacheKey)
    if (cached) return cached

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

      this.setCache(cacheKey, pullRequests)
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

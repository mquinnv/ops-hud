import { describe, expect, test } from "bun:test"
import runsFixture from "../fixtures/github-runs.json"
import { type CommandRunner, GitHubProvider } from "./github.js"
import { type GitHubRunPayload, mapGitHubRun } from "./github-map.js"

// The read path (runs, jobs, older runs) lives in the poller now; this
// provider keeps only the pane-side actions, PRs and the repository listing.

type Call = { file: string; args: string[]; options?: { timeout?: number } }

/** A runner that answers every call with the same body, and records the calls. */
function recordingRunner(stdout: string): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, options })
    return { stdout }
  }
  return { runner, calls }
}

const run = mapGitHubRun(runsFixture.workflow_runs[0] as unknown as GitHubRunPayload)

describe("GitHubProvider run actions", () => {
  test("cancels and reruns by native id against the run's repository", async () => {
    const { runner, calls } = recordingRunner("")
    const provider = new GitHubProvider(runner)

    await provider.cancel(run)
    await provider.rerun(run)

    expect(calls[0].args).toEqual(["run", "cancel", run.id, "-R", run.repo.fullName])
    expect(calls[1].args).toEqual(["run", "rerun", run.id, "-R", run.repo.fullName])
  })

  // `gh run view --log` downloads and unzips the whole archive; 30s was reachable.
  test("gives the log download a minute", async () => {
    const { runner, calls } = recordingRunner("")
    const provider = new GitHubProvider(runner)

    await provider.logs(run)

    expect(calls[0].args).toContain("--log")
    expect(calls[0].options?.timeout).toBe(60000)
  })
})

import { describe, expect, test } from "bun:test"
import jobsFixture from "../fixtures/github-jobs.json"
import runsFixture from "../fixtures/github-runs.json"
import { type CommandRunner, GitHubProvider } from "./github.js"
import type { Scope } from "./types.js"

const scope: Scope = { repositories: ["acme/widgets"] }

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

function failingRunner(message: string): CommandRunner {
  return async () => {
    throw new Error(message)
  }
}

/** A runner that fails the way execa does, with its extra fields. */
function execaFailure(fields: {
  timedOut?: boolean
  stderr?: string
  code?: string
  shortMessage?: string
}): CommandRunner {
  return async () => {
    throw Object.assign(new Error(fields.shortMessage ?? "Command failed"), fields)
  }
}

describe("GitHubProvider.fetchRuns", () => {
  test("maps the payload the API returns", async () => {
    const { runner } = recordingRunner(JSON.stringify(runsFixture))
    const { runs, diagnostics } = await new GitHubProvider(runner).fetchRuns(scope)

    expect(diagnostics).toEqual([])
    expect(runs).toHaveLength(runsFixture.workflow_runs.length)
    expect(runs[0].key).toBe(`github:${runs[0].repo.fullName}:${runs[0].id}`)
    expect(runs[0].provider).toBe("github")
  })

  test("asks the API, not `gh run list`", async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(runsFixture))
    await new GitHubProvider(runner).fetchRuns(scope)

    expect(calls[0].file).toBe("gh")
    expect(calls[0].args[0]).toBe("api")
    expect(calls[0].args[1]).toContain("repos/acme/widgets/actions/runs")
  })

  // A rate limit is a different problem from a broken repository, and the log
  // pane is the only place the user will ever see either.
  test("names a rate limit for what it is", async () => {
    const provider = new GitHubProvider(failingRunner("HTTP 403: API rate limit exceeded for user"))
    const { runs, diagnostics } = await provider.fetchRuns(scope)

    expect(runs).toEqual([])
    expect(diagnostics).toEqual([
      { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
    ])
  })

  test("reports the repository it could not read", async () => {
    const provider = new GitHubProvider(failingRunner("exit code 1"))
    const { diagnostics } = await provider.fetchRuns(scope)

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].message).toStartWith("GitHub: could not list runs for acme/widgets")
    expect(diagnostics[0].level).toBe("error")
  })

  // "could not list runs" alone is undiagnosable: the same call can work by
  // hand. Say why it failed.
  describe("names the cause of a failure", () => {
    const messageFor = async (runner: CommandRunner) =>
      (await new GitHubProvider(runner).fetchRuns(scope)).diagnostics[0]?.message

    test("a timeout, with its limit", async () => {
      const runner = execaFailure({
        timedOut: true,
        shortMessage: "Command timed out after 30000 milliseconds",
      })
      expect(await messageFor(runner)).toBe(
        "GitHub: could not list runs for acme/widgets — timed out after 30s",
      )
    })

    test("gh's own error line", async () => {
      const runner = execaFailure({
        stderr: "gh: Server Error (HTTP 502)\n",
        shortMessage: "Command failed with exit code 1",
      })
      expect(await messageFor(runner)).toBe(
        "GitHub: could not list runs for acme/widgets — gh: Server Error (HTTP 502)",
      )
    })

    test("gh missing from PATH", async () => {
      const runner = execaFailure({ code: "ENOENT", shortMessage: "spawn gh ENOENT" })
      expect(await messageFor(runner)).toBe(
        "GitHub: could not list runs for acme/widgets — gh is not installed or not on PATH",
      )
    })

    test("a response that is not JSON", async () => {
      const { runner } = recordingRunner("<html>oops</html>")
      expect(await messageFor(runner)).toBe(
        "GitHub: could not list runs for acme/widgets — unreadable response",
      )
    })

    // GitHub's abuse limit words it differently from the primary one.
    test("a secondary rate limit is still a rate limit", async () => {
      const runner = execaFailure({
        stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)",
      })
      expect(await messageFor(runner)).toBe("GitHub: API rate limit exceeded")
    })
  })

  test("gives the runs listing 30s before giving up", async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(runsFixture))
    await new GitHubProvider(runner).fetchRuns(scope)
    expect(calls[0].options?.timeout).toBe(30_000)
  })

  test("treats a payload with no workflow_runs as empty, not as an error", async () => {
    const { runner } = recordingRunner("{}")
    const { runs, diagnostics } = await new GitHubProvider(runner).fetchRuns(scope)

    expect(runs).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test("serves a second call from the cache", async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(runsFixture))
    const provider = new GitHubProvider(runner)

    await provider.fetchRuns(scope)
    const second = await provider.fetchRuns(scope)

    expect(calls).toHaveLength(1)
    expect(second.runs).toHaveLength(runsFixture.workflow_runs.length)
  })
})

describe("GitHubProvider.fetchJobs", () => {
  test("maps jobs against the run's key", async () => {
    const { runner } = recordingRunner(JSON.stringify(runsFixture))
    const provider = new GitHubProvider(runner)
    const { runs } = await provider.fetchRuns(scope)

    const jobProvider = new GitHubProvider(recordingRunner(JSON.stringify(jobsFixture)).runner)
    const jobs = await jobProvider.fetchJobs(runs[0])

    expect(jobs).toHaveLength(jobsFixture.jobs.length)
    expect(jobs[0].runKey).toBe(runs[0].key)
    expect(jobs[0].key).toBe(`${runs[0].key}:${jobs[0].id}`)
  })

  test("returns nothing rather than throwing when the call fails", async () => {
    const { runner } = recordingRunner(JSON.stringify(runsFixture))
    const { runs } = await new GitHubProvider(runner).fetchRuns(scope)

    const provider = new GitHubProvider(failingRunner("boom"))
    expect(await provider.fetchJobs(runs[0])).toEqual([])
  })
})

describe("GitHubProvider.fetchOlderRuns", () => {
  test("pages backwards with a created filter and does not use the run cache", async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(runsFixture))
    const provider = new GitHubProvider(runner)

    await provider.fetchRuns(scope)
    const older = await provider.fetchOlderRuns(scope, "2026-09-01T00:00:00Z", 1)

    expect(calls).toHaveLength(2)
    expect(calls[1].args[1]).toContain("created=")
    expect(older.runs).toHaveLength(1)
  })

  // Silence here meant "no older runs", which is a different fact entirely.
  test("reports a failure instead of looking like an empty history", async () => {
    const provider = new GitHubProvider(failingRunner("HTTP 403: API rate limit exceeded"))
    const { runs, diagnostics } = await provider.fetchOlderRuns(scope, "2026-09-01T00:00:00Z", 1)

    expect(runs).toEqual([])
    expect(diagnostics).toEqual([
      { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
    ])
  })

  test("names the repository for a non-rate-limit failure", async () => {
    const provider = new GitHubProvider(failingRunner("exit code 1"))
    const { diagnostics } = await provider.fetchOlderRuns(scope, "2026-09-01T00:00:00Z", 1)

    expect(diagnostics[0].message).toBe(
      "GitHub: could not list older runs for acme/widgets — exit code 1",
    )
  })
})

describe("GitHubProvider run actions", () => {
  test("cancels and reruns by native id against the run's repository", async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(runsFixture))
    const provider = new GitHubProvider(runner)
    const { runs } = await provider.fetchRuns(scope)
    const run = runs[0]

    await provider.cancel(run)
    await provider.rerun(run)

    expect(calls[1].args).toEqual(["run", "cancel", run.id, "-R", run.repo.fullName])
    expect(calls[2].args).toEqual(["run", "rerun", run.id, "-R", run.repo.fullName])
  })

  // `gh run view --log` downloads and unzips the whole archive; 30s was reachable.
  test("gives the log download a minute", async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(runsFixture))
    const provider = new GitHubProvider(runner)
    const { runs } = await provider.fetchRuns(scope)

    await provider.logs(runs[0])

    expect(calls[1].args).toContain("--log")
    expect(calls[1].options?.timeout).toBe(60000)
  })
})

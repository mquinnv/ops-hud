import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { App } from "./app.js"
import { ConfigManager } from "./config.js"
import type { Dashboard } from "./dashboard.js"
import { BuildkiteProvider, type BuildkiteProviderOptions } from "./providers/buildkite.js"
import type { GitHubProvider } from "./providers/github.js"
import type { CiProvider, FetchResult, ProviderDiagnostic, Scope } from "./providers/types.js"
import type { RunStatus } from "./status.js"
import type { BuildkiteConfig, Job, Provider, Run } from "./types.js"

// ---------------------------------------------------------------------------
// Doubles. Everything the App reaches for is injected, so nothing here touches
// a network, a `gh` binary or the terminal.
// ---------------------------------------------------------------------------

function makeRun(partial: Partial<Run> = {}): Run {
  const provider: Provider = partial.provider ?? "github"
  const id = partial.id ?? "1"
  const fullName = partial.repo?.fullName ?? "acme/widgets"
  const [owner, name] = fullName.split("/")

  return {
    provider,
    key: `${provider}:${fullName}:${id}`,
    id,
    number: 1,
    title: "a commit title",
    pipeline: "CI",
    branch: "main",
    sha: "0123456789abcdef",
    status: "running",
    isFailing: false,
    repo: { owner, name, fullName },
    webUrl: "https://example.test/run",
    createdAt: "2026-09-17T10:00:00Z",
    ...partial,
  }
}

function makeJob(runKey: string, status: RunStatus, id = "j1"): Job {
  return { id, key: `${runKey}:${id}`, runKey, name: `job ${id}`, status }
}

class FakeProvider implements CiProvider {
  fetchRunsCalls = 0
  fetchJobsFor: string[] = []
  olderResult: FetchResult = { runs: [], diagnostics: [] }

  constructor(
    readonly name: string,
    private runs: Run[] = [],
    private jobs: Map<string, Job[]> = new Map(),
    private embedJobs = false,
    private diagnostics: FetchResult["diagnostics"] = [],
  ) {}

  setRuns(runs: Run[]): void {
    this.runs = runs
  }

  async fetchRuns(_scope: Scope): Promise<FetchResult> {
    this.fetchRunsCalls++
    return {
      runs: this.runs,
      jobs: this.embedJobs ? this.jobs : undefined,
      diagnostics: this.diagnostics,
    }
  }

  async fetchJobs(run: Run): Promise<Job[]> {
    this.fetchJobsFor.push(run.key)
    return this.jobs.get(run.key) ?? []
  }

  async cancel(): Promise<void> {}
  async rerun(): Promise<void> {}
  async logs(): Promise<string> {
    return ""
  }
}

/** A provider that can page backwards, for the resurrect path. */
class PagingProvider extends FakeProvider {
  async fetchOlderRuns(): Promise<FetchResult> {
    return this.olderResult
  }
}

/** The action callbacks App.setupEventHandlers() registers on the dashboard,
 *  captured so tests can fire them directly without a real terminal. */
interface CapturedHandlers {
  kill?: (run: Run) => void | Promise<void>
  rerun?: (run: Run) => void | Promise<void>
  logs?: (run: Run) => void | Promise<void>
}

function makeDashboard() {
  const rendered: Array<{
    runs: Run[]
    jobs: Map<string, Job[]>
    diagnostics?: ProviderDiagnostic[]
  }> = []
  const logs: string[] = []
  const handlers: CapturedHandlers = {}

  const dashboard = {
    isModalOpen: () => false,
    showLoadingInStatus() {},
    stopRefreshAnimation() {},
    showError() {},
    log(message: string) {
      logs.push(message)
    },
    updateWorkflows(
      runs: Run[],
      jobs: Map<string, Job[]>,
      _prs?: unknown,
      _docker?: unknown,
      diagnostics?: ProviderDiagnostic[],
    ) {
      rendered.push({ runs, jobs, diagnostics })
    },
    getCurrentWorkflows(): Run[] {
      return rendered.at(-1)?.runs ?? []
    },
    destroy() {},
    // No-op event registrations — App.initialize() wires all of these up via
    // setupEventHandlers(), but nothing in these tests fires a dashboard event,
    // except onKillRun/onRunRerun/onRunLogs, whose callbacks are captured
    // above for the provider-wording tests to invoke directly.
    onRefresh() {},
    onExit() {},
    onOpenRun() {},
    onOpenPR() {},
    onDismissRun() {},
    onDismissAllCompleted() {},
    onResurrectRun() {},
    onKillRun(cb: (run: Run) => void | Promise<void>) {
      handlers.kill = cb
    },
    onDockerAction() {},
    onPRMerge() {},
    onPRCheckout() {},
    onPRAction() {},
    onRunRerun(cb: (run: Run) => void | Promise<void>) {
      handlers.rerun = cb
    },
    onRunLogs(cb: (run: Run) => void | Promise<void>) {
      handlers.logs = cb
    },
  }

  return { dashboard: dashboard as unknown as Dashboard, rendered, logs, handlers }
}

interface AppInternals {
  repositories: string[]
  providers: CiProvider[]
  oldestWorkflowTimestamp?: string
  watchedWorkflows: Set<string>
  completedWorkflows: Map<string, Run>
  performRefresh(isManual?: boolean): Promise<void>
  dismissRun(key: string, status?: RunStatus): void
  dismissAllCompletedRuns(runs: Run[]): void
  setupEventHandlers(): void
  buildProviders(args: {
    noGithub?: boolean
    noBuildkite?: boolean
    bkOrg?: string
    pipelines?: string[]
  }): CiProvider[]
}

// History on launch (showCompletedFor) is off unless a test asks for it, so
// each test states the visibility window it depends on.
function makeApp(
  providers: CiProvider[],
  opts: { now?: () => number; historyMinutes?: number } = {},
) {
  const { dashboard, rendered, logs, handlers } = makeDashboard()
  const configManager = new ConfigManager()
  configManager.updateFromArgs({ showCompletedFor: opts.historyMinutes ?? 0 })
  const app = new App({ providers, dashboard, configManager, now: opts.now })
  const internals = app as unknown as AppInternals
  internals.repositories = ["acme/widgets"]
  return { app, internals, rendered, logs, handlers }
}

/** A raw Buildkite build payload, for tests that drive the real provider. */
function bkBuild(state: string, jobs: Array<Record<string, unknown>>, id = "b1") {
  return {
    id,
    number: 1,
    state,
    commit: "deadbeef",
    branch: "main",
    web_url: "https://buildkite.com/acme/widgets/builds/1",
    created_at: "2026-09-17T10:00:00Z",
    pipeline: { slug: "widgets", name: "widgets", repository: "git@github.com:acme/widgets.git" },
    jobs,
  }
}

/**
 * A real ConfigManager that reads from a fresh temp directory and a fresh temp
 * home — never the developer's cwd or `~/.ops-hud.json`.
 */
class IsolatedConfigManager extends ConfigManager {
  readonly base = mkdtempSync(join(tmpdir(), "ops-hud-app-base-"))
  readonly home = mkdtempSync(join(tmpdir(), "ops-hud-app-home-"))

  override loadConfig(configPath?: string) {
    return super.loadConfig(configPath, this.base, this.home)
  }
}

/** A Buildkite stand-in for initialize(): never constructs the real provider. */
const stubBuildkite = (): CiProvider => new FakeProvider("buildkite")

const visibleKeys = (rendered: Array<{ runs: Run[] }>): string[] =>
  (rendered.at(-1)?.runs ?? []).map((run) => run.key)

// ---------------------------------------------------------------------------

describe("performRefresh visibility", () => {
  test("an in-flight run is shown and watched", async () => {
    const run = makeRun({ status: "running" })
    const { internals, rendered } = makeApp([new FakeProvider("github", [run])])

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([run.key])
    expect(internals.watchedWorkflows.has(run.key)).toBe(true)
    expect(internals.completedWorkflows.has(run.key)).toBe(false)
  })

  test("a finished run from before ops-hud started stays off the grid", async () => {
    const run = makeRun({ status: "passed" })
    const { internals, rendered } = makeApp([new FakeProvider("github", [run])], {
      now: () => Date.parse("2026-09-17T11:00:00Z"),
    })

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([])
    expect(internals.watchedWorkflows.has(run.key)).toBe(false)
  })

  // showCompletedFor: on launch, show what finished in the last N minutes
  // rather than an empty grid. The window is fixed at launch, not rolling, so
  // history cards stay until dismissed like any other finished run.
  describe("recent history on launch", () => {
    const start = () => Date.parse("2026-09-17T10:00:00Z")
    const finished = (createdAt: string, finishedAt?: string, id = "1") =>
      makeRun({ status: "passed", createdAt, finishedAt, id })

    test("a run that finished inside the window before launch is shown", async () => {
      const run = finished("2026-09-17T09:10:00Z", "2026-09-17T09:20:00Z")
      const { internals, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 60,
      })

      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
    })

    test("one that finished before the window is not", async () => {
      const run = finished("2026-09-17T08:40:00Z", "2026-09-17T08:50:00Z")
      const { internals, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 60,
      })

      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    // A long run created before the window but finishing inside it happened
    // recently in every sense that matters: judge by when it finished.
    test("finishing time wins over creation time", async () => {
      const run = finished("2026-09-17T08:00:00Z", "2026-09-17T09:30:00Z")
      const { internals, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 60,
      })

      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
    })

    test("a window of 0 turns history off", async () => {
      const run = finished("2026-09-17T09:40:00Z", "2026-09-17T09:50:00Z")
      const { internals, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 0,
      })

      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([])
    })
  })

  test("a run that finishes while watched stays up until it is dismissed", async () => {
    const running = makeRun({ status: "running" })
    const provider = new FakeProvider("github", [running])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...running, status: "passed" }])
    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([running.key])
    expect(internals.completedWorkflows.has(running.key)).toBe(true)
  })

  // Native ids collide across providers; only the composite key is safe.
  test("identity is the composite key, not the native id", async () => {
    const mine = makeRun({ provider: "github", id: "7", status: "running" })
    const theirs = makeRun({ provider: "buildkite", id: "7", status: "passed" })
    const { internals, rendered } = makeApp([new FakeProvider("github", [mine, theirs])])

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([mine.key])
    expect([...internals.watchedWorkflows]).toEqual(["github:acme/widgets:7"])
    expect(internals.watchedWorkflows.has("7")).toBe(false)
  })
})

describe("dismissal", () => {
  // Buildkite is fetched at most every 15s, so a fast build can start and
  // finish between two fetches and never be seen in flight. Whether a run
  // happened while ops-hud was watching is judged by when it was created, not
  // by whether a fetch happened to catch it running.
  describe("runs that happen while ops-hud is watching", () => {
    const start = () => Date.parse("2026-09-17T10:00:00Z")
    const finishedAt = (createdAt: string) => makeRun({ status: "passed", createdAt })

    test("a run that started and finished between two refreshes is still shown", async () => {
      const run = finishedAt("2026-09-17T10:05:00Z")
      const { internals, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
      expect(internals.completedWorkflows.has(run.key)).toBe(true)
    })

    test("a run created just before startup still counts, to absorb clock skew", async () => {
      const run = finishedAt("2026-09-17T09:59:40Z")
      const { internals, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
    })

    test("a run created well before startup does not", async () => {
      const run = finishedAt("2026-09-17T09:59:00Z")
      const { internals, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    test("dismissing one keeps it dismissed across refreshes", async () => {
      const run = finishedAt("2026-09-17T10:05:00Z")
      const { internals, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await internals.performRefresh()
      internals.dismissRun(run.key)
      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    test("dismiss-all keeps them dismissed across refreshes", async () => {
      const a = finishedAt("2026-09-17T10:05:00Z")
      const b = makeRun({ status: "passed", createdAt: "2026-09-17T10:06:00Z", id: "b" })
      const { internals, rendered } = makeApp([new FakeProvider("buildkite", [a, b])], {
        now: start,
      })

      await internals.performRefresh()
      internals.dismissAllCompletedRuns([a, b])
      await internals.performRefresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    // A GitHub rerun keeps the run's id, so its key is unchanged. Dismissing
    // the first attempt must not hide the second one when it finishes.
    test("a dismissed run that is re-run comes back and stays up when it finishes", async () => {
      const run = finishedAt("2026-09-17T10:05:00Z")
      const provider = new FakeProvider("github", [run])
      const { internals, rendered } = makeApp([provider], { now: start })

      await internals.performRefresh()
      internals.dismissRun(run.key)
      provider.setRuns([{ ...run, status: "running" }])
      await internals.performRefresh()
      expect(visibleKeys(rendered)).toEqual([run.key])

      provider.setRuns([{ ...run, status: "failed" }])
      await internals.performRefresh()
      expect(visibleKeys(rendered)).toEqual([run.key])
    })
  })

  test("dismissing a run drops it from both trackers and from the grid", async () => {
    const running = makeRun({ status: "running" })
    const provider = new FakeProvider("github", [running])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...running, status: "passed" }])
    await internals.performRefresh()

    internals.dismissRun(running.key)

    expect(internals.completedWorkflows.has(running.key)).toBe(false)
    expect(internals.watchedWorkflows.has(running.key)).toBe(false)
    expect(visibleKeys(rendered)).toEqual([])
  })

  // Ruling 40: a pipeline that blocks on a manual gate every run must not pile
  // up cards nobody can clear.
  test("dismissing a blocked run hides it while it stays blocked", async () => {
    const blocked = makeRun({ provider: "buildkite", status: "blocked" })
    const provider = new FakeProvider("buildkite", [blocked])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    expect(visibleKeys(rendered)).toEqual([blocked.key])

    internals.dismissRun(blocked.key, "blocked")
    expect(visibleKeys(rendered)).toEqual([])

    await internals.performRefresh()
    expect(visibleKeys(rendered)).toEqual([])
  })

  test("a dismissed blocked run comes back once its status changes", async () => {
    const blocked = makeRun({ provider: "buildkite", status: "blocked" })
    const provider = new FakeProvider("buildkite", [blocked])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    internals.dismissRun(blocked.key, "blocked")
    await internals.performRefresh()
    expect(visibleKeys(rendered)).toEqual([])

    provider.setRuns([{ ...blocked, status: "running" }])
    await internals.performRefresh()
    expect(visibleKeys(rendered)).toEqual([blocked.key])

    // ...and blocking again does not re-hide it: the dismissal was spent.
    provider.setRuns([blocked])
    await internals.performRefresh()
    expect(visibleKeys(rendered)).toEqual([blocked.key])
  })

  test("dismiss-all clears every finished run and leaves the in-flight one", async () => {
    const finished = makeRun({ id: "1", status: "running" })
    const active = makeRun({ id: "2", status: "running" })
    const provider = new FakeProvider("github", [finished, active])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...finished, status: "failed" }, active])
    await internals.performRefresh()

    const terminal = (rendered.at(-1)?.runs ?? []).filter((run) => run.status === "failed")
    internals.dismissAllCompletedRuns(terminal)

    expect(internals.completedWorkflows.size).toBe(0)
    expect(visibleKeys(rendered)).toEqual([active.key])
    expect(internals.watchedWorkflows.has(active.key)).toBe(true)
  })
})

describe("isFailing", () => {
  test("an in-flight run with a failed job is flagged", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([
      [run.key, [makeJob(run.key, "passed", "a"), makeJob(run.key, "failed", "b")]],
    ])
    const { internals, rendered } = makeApp([new FakeProvider("github", [run], jobs)])

    await internals.performRefresh()

    expect(rendered.at(-1)?.runs[0].isFailing).toBe(true)
  })

  test("a healthy in-flight run is not", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([
      [run.key, [makeJob(run.key, "passed", "a"), makeJob(run.key, "running", "b")]],
    ])
    const { internals, rendered } = makeApp([new FakeProvider("github", [run], jobs)])

    await internals.performRefresh()

    expect(rendered.at(-1)?.runs[0].isFailing).toBe(false)
  })

  // Ruling 34: Buildkite's own `failing` state is authoritative. A skipped
  // (broken) job must not make a healthy running build look doomed.
  test("a running Buildkite build with a broken job is not flagged, and the job is skipped", async () => {
    const provider = new BuildkiteProvider({
      token: "t",
      org: "acme",
      pipelines: ["widgets"],
      fetch: async () =>
        new Response(
          JSON.stringify([
            bkBuild("running", [
              { id: "a", type: "script", name: "build", state: "passed" },
              { id: "b", type: "script", name: "deploy", state: "broken" },
            ]),
          ]),
        ),
    })
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()

    const run = rendered.at(-1)?.runs[0]
    expect(run?.isFailing).toBe(false)
    const jobs = rendered.at(-1)?.jobs.get(run?.key ?? "") ?? []
    expect(jobs.find((j) => j.id === "b")?.status).toBe("skipped")
  })

  test("a failing Buildkite build keeps isFailing through performRefresh", async () => {
    const provider = new BuildkiteProvider({
      token: "t",
      org: "acme",
      pipelines: ["widgets"],
      fetch: async () =>
        new Response(
          JSON.stringify([
            bkBuild("failing", [{ id: "a", type: "script", name: "build", state: "passed" }]),
          ]),
        ),
    })
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()

    expect(rendered.at(-1)?.runs[0].isFailing).toBe(true)
  })

  test("a finished run is never flagged — its status already carries the verdict", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "failed", "a")]]])
    const provider = new FakeProvider("github", [run], jobs)
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...run, status: "failed" }])
    await internals.performRefresh()

    expect(rendered.at(-1)?.runs[0].status).toBe("failed")
    expect(rendered.at(-1)?.runs[0].isFailing).toBe(false)
  })
})

describe("multiple providers", () => {
  test("runs from every provider merge into one list, newest first", async () => {
    const older = makeRun({ provider: "github", id: "1", createdAt: "2026-09-17T09:00:00Z" })
    const newer = makeRun({ provider: "buildkite", id: "2", createdAt: "2026-09-17T11:00:00Z" })
    const { internals, rendered } = makeApp([
      new FakeProvider("github", [older]),
      new FakeProvider("buildkite", [newer]),
    ])

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([newer.key, older.key])
  })

  test("jobs a provider hands over with its runs are not fetched again", async () => {
    const run = makeRun({ provider: "buildkite", status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "running")]]])
    const provider = new FakeProvider("buildkite", [run], jobs, true)
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()

    expect(provider.fetchJobsFor).toEqual([])
    expect(rendered.at(-1)?.jobs.get(run.key)).toHaveLength(1)
  })

  // M4: a finished Buildkite card must not say "Loading job details..." when
  // the provider already returned its jobs with the build.
  test("jobs a provider handed over are kept for a finished, still-visible run", async () => {
    const run = makeRun({ provider: "buildkite", status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "passed")]]])
    const provider = new FakeProvider("buildkite", [run], jobs, true)
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...run, status: "passed" }])
    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([run.key])
    expect(rendered.at(-1)?.jobs.get(run.key)).toHaveLength(1)
    expect(provider.fetchJobsFor).toEqual([])
  })

  test("each run's actions go to the provider that reported it", async () => {
    const mine = makeRun({ provider: "github", id: "1" })
    const theirs = makeRun({ provider: "buildkite", id: "2" })
    const github = new FakeProvider("github", [mine])
    const buildkite = new FakeProvider("buildkite", [theirs])
    const { app } = makeApp([github, buildkite])

    const providerFor = (
      app as unknown as { providerFor(run: Run): CiProvider | undefined }
    ).providerFor.bind(app)

    expect(providerFor(mine)).toBe(github)
    expect(providerFor(theirs)).toBe(buildkite)
  })

  // Ruling 36: a steady diagnostic must not flood the 100-line log buffer.
  test("the same diagnostic over three refreshes is logged once", async () => {
    const diagnostic = {
      provider: "buildkite",
      level: "info" as const,
      message: "Buildkite: skipped",
    }
    const provider = new FakeProvider("buildkite", [], new Map(), false, [diagnostic])
    const { internals, logs } = makeApp([provider])

    await internals.performRefresh()
    await internals.performRefresh()
    await internals.performRefresh()

    expect(logs.filter((line) => line === "Buildkite: skipped")).toHaveLength(1)
  })

  test("a changed diagnostic is logged when it changes", async () => {
    const diagnostics: FetchResult["diagnostics"] = [
      { provider: "buildkite", level: "error", message: "Buildkite: HTTP 500" },
    ]
    const provider = new FakeProvider("buildkite", [], new Map(), false, diagnostics)
    const { internals, logs } = makeApp([provider])

    await internals.performRefresh()
    diagnostics[0] = { provider: "buildkite", level: "error", message: "Buildkite: HTTP 502" }
    await internals.performRefresh()
    await internals.performRefresh()

    expect(logs.filter((line) => line.startsWith("Buildkite: HTTP"))).toEqual([
      "Buildkite: HTTP 500",
      "Buildkite: HTTP 502",
    ])
  })

  test("a diagnostic that disappears and returns is logged again", async () => {
    const diagnostics: FetchResult["diagnostics"] = [
      { provider: "buildkite", level: "error", message: "Buildkite: HTTP 500" },
    ]
    const provider = new FakeProvider("buildkite", [], new Map(), false, diagnostics)
    const { internals, logs } = makeApp([provider])

    await internals.performRefresh()
    diagnostics.pop()
    await internals.performRefresh()
    diagnostics.push({ provider: "buildkite", level: "error", message: "Buildkite: HTTP 500" })
    await internals.performRefresh()

    expect(logs.filter((line) => line === "Buildkite: HTTP 500")).toHaveLength(2)
  })

  test("a provider's diagnostics reach the log pane", async () => {
    const provider = new FakeProvider("github", [], new Map(), false, [
      { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
    ])
    const { internals, logs } = makeApp([provider])

    await internals.performRefresh()

    expect(logs).toContain("GitHub: API rate limit exceeded")
  })
})

// Ops-hud Task 8 (Ruling 31): the action log lines the kill/rerun handlers
// emit must use the wording the run's own provider uses — "workflow run" and
// "rerun" for GitHub, "build" and "rebuild" for Buildkite — never one
// hard-coded term for both. Routing to the right provider is already covered
// above ("each run's actions go to the provider that reported it"); these
// tests cover the wording those handlers log once routed.
describe("provider-accurate action wording", () => {
  test("cancelling a Buildkite run logs 'build', not 'workflow run'", async () => {
    const run = makeRun({ provider: "buildkite" })
    const provider = new FakeProvider("buildkite", [run])
    const { internals, logs, handlers } = makeApp([provider])
    internals.setupEventHandlers()

    await handlers.kill?.(run)

    expect(logs.some((line) => line.includes("build"))).toBe(true)
    expect(logs.some((line) => line.includes("workflow run"))).toBe(false)
  })

  test("cancelling a GitHub run logs 'workflow run'", async () => {
    const run = makeRun({ provider: "github" })
    const provider = new FakeProvider("github", [run])
    const { internals, logs, handlers } = makeApp([provider])
    internals.setupEventHandlers()

    await handlers.kill?.(run)

    expect(logs.some((line) => line.includes("workflow run"))).toBe(true)
  })

  test("rerunning a Buildkite run logs 'rebuild', not 'rerun'", async () => {
    const run = makeRun({ provider: "buildkite" })
    const provider = new FakeProvider("buildkite", [run])
    const { internals, logs, handlers } = makeApp([provider])
    internals.setupEventHandlers()

    await handlers.rerun?.(run)

    expect(logs.some((line) => line.includes("rebuild"))).toBe(true)
    expect(logs.some((line) => line.includes("rerun"))).toBe(false)
  })

  test("rerunning a GitHub run logs 'rerun'", async () => {
    const run = makeRun({ provider: "github" })
    const provider = new FakeProvider("github", [run])
    const { internals, logs, handlers } = makeApp([provider])
    internals.setupEventHandlers()

    await handlers.rerun?.(run)

    expect(logs.some((line) => line.includes("rerun"))).toBe(true)
  })
})

describe("resurrect", () => {
  test("a rate-limited resurrect says so instead of claiming there is nothing older", async () => {
    const provider = new PagingProvider("github", [makeRun({ status: "running" })])
    provider.olderResult = {
      runs: [],
      diagnostics: [
        { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
      ],
    }
    const { app, internals, logs } = makeApp([provider])

    await internals.performRefresh()
    await app.resurrectOldestRun()

    expect(logs).toContain("GitHub: API rate limit exceeded")
  })

  test("a provider that cannot page backwards simply sits it out", async () => {
    const paging = new PagingProvider("github", [makeRun({ status: "running" })])
    const other = new FakeProvider("buildkite", [makeRun({ provider: "buildkite", id: "9" })])
    const { app, internals, logs } = makeApp([paging, other])

    await internals.performRefresh()
    await app.resurrectOldestRun()

    expect(logs).toContain("No older workflows found")
  })

  // M5: an old Buildkite build in the merged list must not set the cursor
  // GitHub is asked to page back from, or every GitHub run in between is skipped.
  test("the resurrect cursor comes only from providers that can page backwards", async () => {
    const github = new PagingProvider("github", [
      makeRun({ id: "1", createdAt: "2026-09-17T10:00:00Z" }),
    ])
    const buildkite = new FakeProvider("buildkite", [
      makeRun({ provider: "buildkite", id: "2", createdAt: "2020-01-01T00:00:00Z" }),
    ])
    const { internals } = makeApp([github, buildkite])

    await internals.performRefresh()

    expect(internals.oldestWorkflowTimestamp).toBe("2026-09-17T10:00:00Z")
  })

  test("an older run comes back as a finished, dismissible card", async () => {
    const provider = new PagingProvider("github", [makeRun({ id: "2", status: "running" })])
    const old = makeRun({ id: "1", status: "passed", createdAt: "2026-09-16T10:00:00Z" })
    provider.olderResult = { runs: [old], diagnostics: [] }
    const { app, internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    await app.resurrectOldestRun()

    expect(visibleKeys(rendered)).toContain(old.key)
    expect(internals.completedWorkflows.has(old.key)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Provider assembly (Ruling 25 / Ruling 26 / Ruling 27). Built in
// initialize(), never in the constructor, because config isn't loaded yet
// there. The Buildkite provider is never constructed for real — a factory
// seam captures the options it would have been built with.
// ---------------------------------------------------------------------------

describe("provider assembly", () => {
  const originalToken = process.env.BUILDKITE_API_TOKEN

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.BUILDKITE_API_TOKEN
    } else {
      process.env.BUILDKITE_API_TOKEN = originalToken
    }
  })

  function makeAssemblyApp(buildkiteConfig: BuildkiteConfig = {}) {
    const { dashboard } = makeDashboard()
    const captured: BuildkiteProviderOptions[] = []
    const configManager = { buildkite: buildkiteConfig } as unknown as ConfigManager
    const app = new App({
      dashboard,
      configManager,
      buildkiteFactory: (options) => {
        captured.push(options)
        return { name: "buildkite" } as unknown as CiProvider
      },
    })
    return { internals: app as unknown as AppInternals, captured }
  }

  test("both providers are built by default", () => {
    const { internals, captured } = makeAssemblyApp()

    const providers = internals.buildProviders({})

    expect(providers.map((p) => p.name)).toEqual(["github", "buildkite"])
    expect(captured).toHaveLength(1)
  })

  test("--no-buildkite omits the Buildkite provider", () => {
    const { internals, captured } = makeAssemblyApp()

    const providers = internals.buildProviders({ noBuildkite: true })

    expect(providers.map((p) => p.name)).toEqual(["github"])
    expect(captured).toHaveLength(0)
  })

  test("--no-github omits GitHubProvider from the CI provider list", () => {
    const { internals } = makeAssemblyApp()

    const providers = internals.buildProviders({ noGithub: true })

    expect(providers.map((p) => p.name)).toEqual(["buildkite"])
  })

  test("--bk-org overrides buildkite.org", () => {
    const { internals, captured } = makeAssemblyApp({ org: "config-org" })

    internals.buildProviders({ bkOrg: "flag-org" })

    expect(captured[0].org).toBe("flag-org")
  })

  test("without --bk-org, buildkite.org from config is used", () => {
    const { internals, captured } = makeAssemblyApp({ org: "config-org" })

    internals.buildProviders({})

    expect(captured[0].org).toBe("config-org")
  })

  test("--pipeline overrides buildkite.pipelines", () => {
    const { internals, captured } = makeAssemblyApp({ pipelines: ["config-pipe"] })

    internals.buildProviders({ pipelines: ["flag-pipe"] })

    expect(captured[0].pipelines).toEqual(["flag-pipe"])
  })

  test("the env token beats the config token", () => {
    process.env.BUILDKITE_API_TOKEN = "env-token"
    const { internals, captured } = makeAssemblyApp({ token: "config-token" })

    internals.buildProviders({})

    expect(captured[0].token).toBe("env-token")
  })

  test("with no env token, the config token is used", () => {
    delete process.env.BUILDKITE_API_TOKEN
    const { internals, captured } = makeAssemblyApp({ token: "config-token" })

    internals.buildProviders({})

    expect(captured[0].token).toBe("config-token")
  })
})

describe("initialize() and injected providers", () => {
  test("providers injected through AppDependencies survive initialize() untouched", async () => {
    const provider = new FakeProvider("acme-ci", [])
    const { dashboard } = makeDashboard()
    const configManager = new IsolatedConfigManager()
    let buildkiteFactoryCalls = 0
    const app = new App({
      providers: [provider],
      dashboard,
      configManager,
      buildkiteFactory: () => {
        buildkiteFactoryCalls++
        return { name: "buildkite" } as unknown as CiProvider
      },
    })

    await app.initialize({ repositories: ["acme/widgets"] })
    const internals = app as unknown as AppInternals

    expect(internals.providers).toEqual([provider])
    expect(buildkiteFactoryCalls).toBe(0)

    app.stop()
  })
})

describe("--no-github disables GitHub CI runs only (Ruling 26)", () => {
  // Nothing here may reach the developer's environment: a BUILDKITE_API_TOKEN
  // exported in the shell (the README says to) must not turn `bun test` into
  // real API traffic.
  const originalToken = process.env.BUILDKITE_API_TOKEN
  beforeEach(() => {
    delete process.env.BUILDKITE_API_TOKEN
  })
  afterEach(() => {
    if (originalToken === undefined) delete process.env.BUILDKITE_API_TOKEN
    else process.env.BUILDKITE_API_TOKEN = originalToken
  })

  test("repository resolution and PR fetching still go through the GitHub provider", async () => {
    const { dashboard } = makeDashboard()
    const configManager = new IsolatedConfigManager()
    let getAllPullRequestsCalls = 0
    const listedOrgs: string[] = []
    const fakeGithub = {
      name: "github",
      async getAllPullRequests(_repos: string[]) {
        getAllPullRequestsCalls++
        return []
      },
      async listRepositories(org: string) {
        listedOrgs.push(org)
        return [{ owner: "acme", name: "widgets", fullName: "acme/widgets" }]
      },
    } as unknown as GitHubProvider

    const app = new App({
      github: fakeGithub,
      dashboard,
      configManager,
      buildkiteFactory: stubBuildkite,
    })

    await app.initialize({
      organizations: ["acme"],
      showPRs: true,
      noGithub: true,
    })
    const internals = app as unknown as AppInternals

    // GitHub is excluded from the CI provider list...
    expect(internals.providers.map((p) => p.name)).toEqual(["buildkite"])
    // ...but repository resolution still went through the GitHub provider...
    expect(listedOrgs).toEqual(["acme"])
    expect(internals.repositories).toEqual(["acme/widgets"])
    // ...and so did PR fetching (governed by --show-prs, not --no-github).
    expect(getAllPullRequestsCalls).toBeGreaterThan(0)

    app.stop()
  })
})

describe("initialize() explains its setup", () => {
  const originalToken = process.env.BUILDKITE_API_TOKEN
  beforeEach(() => {
    delete process.env.BUILDKITE_API_TOKEN
  })
  afterEach(() => {
    if (originalToken === undefined) delete process.env.BUILDKITE_API_TOKEN
    else process.env.BUILDKITE_API_TOKEN = originalToken
  })

  function makeInitApp(configManager: ConfigManager) {
    const { dashboard, rendered, logs } = makeDashboard()
    const fakeGithub = new FakeProvider("github") as unknown as GitHubProvider
    const app = new App({
      github: fakeGithub,
      dashboard,
      configManager,
      buildkiteFactory: stubBuildkite,
    })
    return { app, rendered, logs }
  }

  // M2: an empty grid under --no-buildkite must say why there are no builds.
  test("--no-buildkite adds a single info diagnostic saying so", async () => {
    const { app, rendered } = makeInitApp(new IsolatedConfigManager())

    await app.initialize({ repositories: ["acme/widgets"], noBuildkite: true })

    const diagnostics = rendered.at(-1)?.diagnostics ?? []
    expect(diagnostics).toEqual([
      { provider: "buildkite", level: "info", message: "Buildkite: disabled (--no-buildkite)" },
    ])
    app.stop()
  })

  test("without --no-buildkite there is no such diagnostic", async () => {
    const { app, rendered } = makeInitApp(new IsolatedConfigManager())

    await app.initialize({ repositories: ["acme/widgets"] })

    const messages = (rendered.at(-1)?.diagnostics ?? []).map((d) => d.message)
    expect(messages).not.toContain("Buildkite: disabled (--no-buildkite)")
    app.stop()
  })

  // M10: a legacy ./.gh-hud.json shadowed by a newer ~/.ops-hud.json must be visible.
  test("the loaded config file is logged", async () => {
    const configManager = new IsolatedConfigManager()
    const path = join(configManager.home, ".ops-hud.json")
    writeFileSync(path, JSON.stringify({ maxWorkflows: 5 }))
    const { app, logs } = makeInitApp(configManager)

    await app.initialize({ repositories: ["acme/widgets"] })

    expect(logs).toContain(`Config: loaded ${path}`)
    app.stop()
  })

  test("no config file is logged as such", async () => {
    const { app, logs } = makeInitApp(new IsolatedConfigManager())

    await app.initialize({ repositories: ["acme/widgets"] })

    expect(logs).toContain("Config: no config file found, using defaults")
    app.stop()
  })
})

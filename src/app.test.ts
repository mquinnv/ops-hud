import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { App, PR_REFRESH_MS } from "./app.js"
import { ConfigManager } from "./config.js"
import type { Dashboard } from "./dashboard.js"
import type { PollerClient, PollerStatus } from "./poller/client.js"
import type { Budget, Snapshot, Subscription } from "./poller/protocol.js"
import { BuildkiteProvider, type BuildkiteProviderOptions } from "./providers/buildkite.js"
import type { GitHubProvider } from "./providers/github.js"
import type {
  CiProvider,
  CiReader,
  FetchResult,
  ProviderDiagnostic,
  Scope,
} from "./providers/types.js"
import type { RunStatus } from "./status.js"
import { isActive } from "./status.js"
import type { BuildkiteConfig, Job, Provider, PullRequest, Run } from "./types.js"

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

class FakeProvider implements CiProvider, CiReader {
  fetchRunsCalls = 0
  fetchJobsFor: string[] = []
  cancelled: string[] = []

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

  async cancel(run: Run): Promise<void> {
    this.cancelled.push(run.key)
  }
  async rerun(): Promise<void> {}
  async logs(): Promise<string> {
    return ""
  }
}

/**
 * Stands in for the shared poller: records what the pane asks of it and lets
 * a test push snapshots, budgets and status changes at the App.
 */
class FakePollerClient implements PollerClient {
  calls: string[] = []
  watches: Subscription[] = []
  refreshes: Array<string[] | undefined> = []
  olders: Array<{ repositories: string[]; before: string; limit: number }> = []
  olderResult: FetchResult = { runs: [], diagnostics: [] }
  closed = false
  private snapshotCbs: Array<(snapshot: Snapshot) => void> = []
  private budgetCbs: Array<(budget: Budget) => void> = []
  private statusCbs: Array<(status: PollerStatus) => void> = []

  async start(): Promise<void> {
    this.calls.push("start")
  }
  watch(subscription: Subscription): void {
    this.calls.push("watch")
    this.watches.push(subscription)
  }
  refresh(repositories?: string[]): void {
    this.refreshes.push(repositories)
  }
  async older(repositories: string[], before: string, limit: number): Promise<FetchResult> {
    this.olders.push({ repositories, before, limit })
    return this.olderResult
  }
  onSnapshot(cb: (snapshot: Snapshot) => void): void {
    this.snapshotCbs.push(cb)
  }
  onBudget(cb: (budget: Budget) => void): void {
    this.budgetCbs.push(cb)
  }
  onStatus(cb: (status: PollerStatus) => void): void {
    this.statusCbs.push(cb)
  }
  close(): void {
    this.closed = true
  }

  emitSnapshot(snapshot: Snapshot): void {
    for (const cb of this.snapshotCbs) cb(snapshot)
  }
  emitBudget(budget: Budget): void {
    for (const cb of this.budgetCbs) cb(budget)
  }
  emitStatus(status: PollerStatus): void {
    for (const cb of this.statusCbs) cb(status)
  }
}

/**
 * What the poller would send for these providers: their runs, the jobs they
 * embedded, and a jobs fetch for each active run that came without any.
 */
async function snapshotFrom(
  providers: Array<CiProvider & CiReader>,
  repositories: string[],
): Promise<Snapshot> {
  const scope: Scope = { repositories }
  const results = await Promise.all(providers.map((provider) => provider.fetchRuns(scope)))
  const runs: Run[] = []
  const jobs: Record<string, Job[]> = {}
  const diagnostics: ProviderDiagnostic[] = []
  for (const [index, result] of results.entries()) {
    runs.push(...result.runs)
    diagnostics.push(...result.diagnostics)
    for (const [key, embedded] of result.jobs ?? []) jobs[key] = embedded
    for (const run of result.runs) {
      if (jobs[run.key] === undefined && isActive(run.status)) {
        jobs[run.key] = await providers[index].fetchJobs(run)
      }
    }
  }
  return { repositories, runs, jobs, diagnostics }
}

const emptySnapshot = (repositories: string[] = ["acme/widgets"]): Snapshot => ({
  repositories,
  runs: [],
  jobs: {},
  diagnostics: [],
})

/** The action callbacks App.setupEventHandlers() registers on the dashboard,
 *  captured so tests can fire them directly without a real terminal. */
interface CapturedHandlers {
  refresh?: () => void
  kill?: (run: Run) => void | Promise<void>
  rerun?: (run: Run) => void | Promise<void>
  logs?: (run: Run) => void | Promise<void>
}

function makeDashboard() {
  const rendered: Array<{
    runs: Run[]
    jobs: Map<string, Job[]>
    diagnostics?: ProviderDiagnostic[]
    prs?: PullRequest[]
  }> = []
  const logs: string[] = []
  const handlers: CapturedHandlers = {}
  const budgets: Array<Budget | undefined> = []
  const statuses: PollerStatus[] = []
  const loading = { count: 0 }

  const dashboard = {
    isModalOpen: () => false,
    showLoadingInStatus() {
      loading.count++
    },
    stopRefreshAnimation() {},
    setBudget(budget: Budget | undefined) {
      budgets.push(budget)
    },
    setPollerStatus(status: PollerStatus) {
      statuses.push(status)
    },
    showError() {},
    log(message: string) {
      logs.push(message)
    },
    updateWorkflows(
      runs: Run[],
      jobs: Map<string, Job[]>,
      prs?: PullRequest[],
      _docker?: unknown,
      diagnostics?: ProviderDiagnostic[],
    ) {
      rendered.push({ runs, jobs, diagnostics, prs })
    },
    getCurrentWorkflows(): Run[] {
      return rendered.at(-1)?.runs ?? []
    },
    destroy() {},
    // No-op event registrations — App.initialize() wires all of these up via
    // setupEventHandlers(), but nothing in these tests fires a dashboard event,
    // except onRefresh/onKillRun/onRunRerun/onRunLogs, whose callbacks are
    // captured for the tests to invoke directly.
    onRefresh(cb: () => void) {
      handlers.refresh = cb
    },
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

  return {
    dashboard: dashboard as unknown as Dashboard,
    rendered,
    logs,
    handlers,
    budgets,
    statuses,
    loading,
  }
}

interface AppInternals {
  repositories: string[]
  providers: CiProvider[]
  oldestWorkflowTimestamp?: string
  watchedWorkflows: Set<string>
  completedWorkflows: Map<string, Run>
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
  providers: Array<CiProvider & CiReader>,
  opts: { now?: () => number; historyMinutes?: number } = {},
) {
  const { dashboard, rendered, logs, handlers, loading } = makeDashboard()
  const configManager = new ConfigManager()
  configManager.updateFromArgs({ showCompletedFor: opts.historyMinutes ?? 0 })
  const client = new FakePollerClient()
  const app = new App({ providers, dashboard, configManager, now: opts.now, pollerClient: client })
  const internals = app as unknown as AppInternals
  internals.repositories = ["acme/widgets"]
  /** One poll: what the poller would send for these providers, applied. */
  const refresh = async () => app.applySnapshot(await snapshotFrom(providers, ["acme/widgets"]))
  return { app, internals, rendered, logs, handlers, client, refresh, loading }
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

describe("snapshot visibility", () => {
  test("an in-flight run is shown and watched", async () => {
    const run = makeRun({ status: "running" })
    const { internals, refresh, rendered } = makeApp([new FakeProvider("github", [run])])

    await refresh()

    expect(visibleKeys(rendered)).toEqual([run.key])
    expect(internals.watchedWorkflows.has(run.key)).toBe(true)
    expect(internals.completedWorkflows.has(run.key)).toBe(false)
  })

  test("a finished run from before ops-hud started stays off the grid", async () => {
    const run = makeRun({ status: "passed" })
    const { internals, refresh, rendered } = makeApp([new FakeProvider("github", [run])], {
      now: () => Date.parse("2026-09-17T11:00:00Z"),
    })

    await refresh()

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
      const { refresh, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 60,
      })

      await refresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
    })

    test("one that finished before the window is not", async () => {
      const run = finished("2026-09-17T08:40:00Z", "2026-09-17T08:50:00Z")
      const { refresh, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 60,
      })

      await refresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    // A long run created before the window but finishing inside it happened
    // recently in every sense that matters: judge by when it finished.
    test("finishing time wins over creation time", async () => {
      const run = finished("2026-09-17T08:00:00Z", "2026-09-17T09:30:00Z")
      const { refresh, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 60,
      })

      await refresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
    })

    test("a window of 0 turns history off", async () => {
      const run = finished("2026-09-17T09:40:00Z", "2026-09-17T09:50:00Z")
      const { refresh, rendered } = makeApp([new FakeProvider("github", [run])], {
        now: start,
        historyMinutes: 0,
      })

      await refresh()

      expect(visibleKeys(rendered)).toEqual([])
    })
  })

  test("a run that finishes while watched stays up until it is dismissed", async () => {
    const running = makeRun({ status: "running" })
    const provider = new FakeProvider("github", [running])
    const { internals, refresh, rendered } = makeApp([provider])

    await refresh()
    provider.setRuns([{ ...running, status: "passed" }])
    await refresh()

    expect(visibleKeys(rendered)).toEqual([running.key])
    expect(internals.completedWorkflows.has(running.key)).toBe(true)
  })

  // Native ids collide across providers; only the composite key is safe.
  test("identity is the composite key, not the native id", async () => {
    const mine = makeRun({ provider: "github", id: "7", status: "running" })
    const theirs = makeRun({ provider: "buildkite", id: "7", status: "passed" })
    const { internals, refresh, rendered } = makeApp([new FakeProvider("github", [mine, theirs])])

    await refresh()

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
      const { internals, refresh, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await refresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
      expect(internals.completedWorkflows.has(run.key)).toBe(true)
    })

    test("a run created just before startup still counts, to absorb clock skew", async () => {
      const run = finishedAt("2026-09-17T09:59:40Z")
      const { refresh, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await refresh()

      expect(visibleKeys(rendered)).toEqual([run.key])
    })

    test("a run created well before startup does not", async () => {
      const run = finishedAt("2026-09-17T09:59:00Z")
      const { refresh, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await refresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    test("dismissing one keeps it dismissed across refreshes", async () => {
      const run = finishedAt("2026-09-17T10:05:00Z")
      const { internals, refresh, rendered } = makeApp([new FakeProvider("buildkite", [run])], {
        now: start,
      })

      await refresh()
      internals.dismissRun(run.key)
      await refresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    test("dismiss-all keeps them dismissed across refreshes", async () => {
      const a = finishedAt("2026-09-17T10:05:00Z")
      const b = makeRun({ status: "passed", createdAt: "2026-09-17T10:06:00Z", id: "b" })
      const { internals, refresh, rendered } = makeApp([new FakeProvider("buildkite", [a, b])], {
        now: start,
      })

      await refresh()
      internals.dismissAllCompletedRuns([a, b])
      await refresh()

      expect(visibleKeys(rendered)).toEqual([])
    })

    // A GitHub rerun keeps the run's id, so its key is unchanged. Dismissing
    // the first attempt must not hide the second one when it finishes.
    test("a dismissed run that is re-run comes back and stays up when it finishes", async () => {
      const run = finishedAt("2026-09-17T10:05:00Z")
      const provider = new FakeProvider("github", [run])
      const { internals, refresh, rendered } = makeApp([provider], { now: start })

      await refresh()
      internals.dismissRun(run.key)
      provider.setRuns([{ ...run, status: "running" }])
      await refresh()
      expect(visibleKeys(rendered)).toEqual([run.key])

      provider.setRuns([{ ...run, status: "failed" }])
      await refresh()
      expect(visibleKeys(rendered)).toEqual([run.key])
    })
  })

  test("dismissing a run drops it from both trackers and from the grid", async () => {
    const running = makeRun({ status: "running" })
    const provider = new FakeProvider("github", [running])
    const { internals, refresh, rendered } = makeApp([provider])

    await refresh()
    provider.setRuns([{ ...running, status: "passed" }])
    await refresh()

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
    const { internals, refresh, rendered } = makeApp([provider])

    await refresh()
    expect(visibleKeys(rendered)).toEqual([blocked.key])

    internals.dismissRun(blocked.key, "blocked")
    expect(visibleKeys(rendered)).toEqual([])

    await refresh()
    expect(visibleKeys(rendered)).toEqual([])
  })

  test("a dismissed blocked run comes back once its status changes", async () => {
    const blocked = makeRun({ provider: "buildkite", status: "blocked" })
    const provider = new FakeProvider("buildkite", [blocked])
    const { internals, refresh, rendered } = makeApp([provider])

    await refresh()
    internals.dismissRun(blocked.key, "blocked")
    await refresh()
    expect(visibleKeys(rendered)).toEqual([])

    provider.setRuns([{ ...blocked, status: "running" }])
    await refresh()
    expect(visibleKeys(rendered)).toEqual([blocked.key])

    // ...and blocking again does not re-hide it: the dismissal was spent.
    provider.setRuns([blocked])
    await refresh()
    expect(visibleKeys(rendered)).toEqual([blocked.key])
  })

  test("dismiss-all clears every finished run and leaves the in-flight one", async () => {
    const finished = makeRun({ id: "1", status: "running" })
    const active = makeRun({ id: "2", status: "running" })
    const provider = new FakeProvider("github", [finished, active])
    const { internals, refresh, rendered } = makeApp([provider])

    await refresh()
    provider.setRuns([{ ...finished, status: "failed" }, active])
    await refresh()

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
    const { refresh, rendered } = makeApp([new FakeProvider("github", [run], jobs)])

    await refresh()

    expect(rendered.at(-1)?.runs[0].isFailing).toBe(true)
  })

  test("a healthy in-flight run is not", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([
      [run.key, [makeJob(run.key, "passed", "a"), makeJob(run.key, "running", "b")]],
    ])
    const { refresh, rendered } = makeApp([new FakeProvider("github", [run], jobs)])

    await refresh()

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
    const { refresh, rendered } = makeApp([provider])

    await refresh()

    const run = rendered.at(-1)?.runs[0]
    expect(run?.isFailing).toBe(false)
    const jobs = rendered.at(-1)?.jobs.get(run?.key ?? "") ?? []
    expect(jobs.find((j) => j.id === "b")?.status).toBe("skipped")
  })

  test("a failing Buildkite build keeps isFailing through a snapshot", async () => {
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
    const { refresh, rendered } = makeApp([provider])

    await refresh()

    expect(rendered.at(-1)?.runs[0].isFailing).toBe(true)
  })

  test("a finished run is never flagged — its status already carries the verdict", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "failed", "a")]]])
    const provider = new FakeProvider("github", [run], jobs)
    const { refresh, rendered } = makeApp([provider])

    await refresh()
    provider.setRuns([{ ...run, status: "failed" }])
    await refresh()

    expect(rendered.at(-1)?.runs[0].status).toBe("failed")
    expect(rendered.at(-1)?.runs[0].isFailing).toBe(false)
  })
})

describe("multiple providers", () => {
  test("runs from every provider merge into one list, newest first", async () => {
    const older = makeRun({ provider: "github", id: "1", createdAt: "2026-09-17T09:00:00Z" })
    const newer = makeRun({ provider: "buildkite", id: "2", createdAt: "2026-09-17T11:00:00Z" })
    const { refresh, rendered } = makeApp([
      new FakeProvider("github", [older]),
      new FakeProvider("buildkite", [newer]),
    ])

    await refresh()

    expect(visibleKeys(rendered)).toEqual([newer.key, older.key])
  })

  test("jobs a provider hands over with its runs are not fetched again", async () => {
    const run = makeRun({ provider: "buildkite", status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "running")]]])
    const provider = new FakeProvider("buildkite", [run], jobs, true)
    const { refresh, rendered } = makeApp([provider])

    await refresh()

    expect(provider.fetchJobsFor).toEqual([])
    expect(rendered.at(-1)?.jobs.get(run.key)).toHaveLength(1)
  })

  // M4: a finished Buildkite card must not say "Loading job details..." when
  // the provider already returned its jobs with the build.
  test("jobs a provider handed over are kept for a finished, still-visible run", async () => {
    const run = makeRun({ provider: "buildkite", status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "passed")]]])
    const provider = new FakeProvider("buildkite", [run], jobs, true)
    const { refresh, rendered } = makeApp([provider])

    await refresh()
    provider.setRuns([{ ...run, status: "passed" }])
    await refresh()

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
    const { refresh, logs } = makeApp([provider])

    await refresh()
    await refresh()
    await refresh()

    expect(logs.filter((line) => line === "Buildkite: skipped")).toHaveLength(1)
  })

  test("a changed diagnostic is logged when it changes", async () => {
    const diagnostics: FetchResult["diagnostics"] = [
      { provider: "buildkite", level: "error", message: "Buildkite: HTTP 500" },
    ]
    const provider = new FakeProvider("buildkite", [], new Map(), false, diagnostics)
    const { refresh, logs } = makeApp([provider])

    await refresh()
    diagnostics[0] = { provider: "buildkite", level: "error", message: "Buildkite: HTTP 502" }
    await refresh()
    await refresh()

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
    const { refresh, logs } = makeApp([provider])

    await refresh()
    diagnostics.pop()
    await refresh()
    diagnostics.push({ provider: "buildkite", level: "error", message: "Buildkite: HTTP 500" })
    await refresh()

    expect(logs.filter((line) => line === "Buildkite: HTTP 500")).toHaveLength(2)
  })

  test("a provider's diagnostics reach the log pane", async () => {
    const provider = new FakeProvider("github", [], new Map(), false, [
      { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
    ])
    const { refresh, logs } = makeApp([provider])

    await refresh()

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
    const provider = new FakeProvider("github", [makeRun({ status: "running" })])
    const { app, logs, client, refresh } = makeApp([provider])
    client.olderResult = {
      runs: [],
      diagnostics: [
        { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
      ],
    }

    await refresh()
    await app.resurrectOldestRun()

    expect(logs).toContain("GitHub: API rate limit exceeded")
  })

  // Only GitHub can page backwards: Buildkite runs never set the cursor, so
  // with nothing but Buildkite on the grid the poller is not asked at all.
  test("Buildkite runs alone give resurrect no cursor and ask the poller nothing", async () => {
    const buildkite = new FakeProvider("buildkite", [
      makeRun({ provider: "buildkite", id: "9", status: "running" }),
    ])
    const { app, internals, logs, client, refresh } = makeApp([buildkite])

    await refresh()
    await app.resurrectOldestRun()

    expect(internals.oldestWorkflowTimestamp).toBeUndefined()
    expect(client.olders).toEqual([])
    expect(logs).toContain("No older workflows available to resurrect")
  })

  // M5: an old Buildkite build in the merged list must not set the cursor
  // GitHub is asked to page back from, or every GitHub run in between is skipped.
  test("resurrect asks the poller for runs older than the oldest GitHub run", async () => {
    const github = new FakeProvider("github", [
      makeRun({ id: "1", createdAt: "2026-09-17T10:00:00Z" }),
      makeRun({ id: "3", createdAt: "2026-09-17T12:00:00Z" }),
    ])
    const buildkite = new FakeProvider("buildkite", [
      makeRun({ provider: "buildkite", id: "2", createdAt: "2020-01-01T00:00:00Z" }),
    ])
    const { app, internals, client, refresh } = makeApp([github, buildkite])

    await refresh()
    await app.resurrectOldestRun()

    expect(internals.oldestWorkflowTimestamp).toBe("2026-09-17T10:00:00Z")
    expect(client.olders).toEqual([
      { repositories: ["acme/widgets"], before: "2026-09-17T10:00:00Z", limit: 1 },
    ])
  })

  test("an older run comes back as a finished, dismissible card", async () => {
    const provider = new FakeProvider("github", [makeRun({ id: "2", status: "running" })])
    const old = makeRun({ id: "1", status: "passed", createdAt: "2026-09-16T10:00:00Z" })
    const { app, internals, rendered, client, refresh } = makeApp([provider])
    client.olderResult = { runs: [old], diagnostics: [] }

    await refresh()
    await app.resurrectOldestRun()

    expect(visibleKeys(rendered)).toContain(old.key)
    expect(internals.completedWorkflows.has(old.key)).toBe(true)
    // ...and the next resurrect pages back from it.
    expect(internals.oldestWorkflowTimestamp).toBe(old.createdAt)
  })
})

describe("poller-driven actions", () => {
  test("r sends refresh to the poller", () => {
    const { internals, handlers, client, loading } = makeApp([new FakeProvider("github")])
    internals.setupEventHandlers()

    handlers.refresh?.()

    expect(client.refreshes).toEqual([undefined])
    expect(loading.count).toBe(1)
  })

  test("after a cancel the run's repo is refreshed through the poller", async () => {
    const run = makeRun({
      provider: "github",
      repo: { owner: "acme", name: "gears", fullName: "acme/gears" },
    })
    const github = new FakeProvider("github", [run])
    const { internals, handlers, client } = makeApp([github])
    internals.setupEventHandlers()

    await handlers.kill?.(run)

    expect(github.cancelled).toEqual([run.key])
    expect(client.refreshes).toEqual([["acme/gears"]])
  })

  test("a failed cancel does not ask the poller for anything", async () => {
    const run = makeRun({ provider: "github" })
    const github = new FakeProvider("github", [run])
    github.cancel = async () => {
      throw new Error("nope")
    }
    const { internals, handlers, client } = makeApp([github])
    internals.setupEventHandlers()

    await handlers.kill?.(run)

    expect(client.refreshes).toEqual([])
  })

  test("after a rerun the run's repo is refreshed through the poller", async () => {
    const run = makeRun({ provider: "buildkite" })
    const { internals, handlers, client } = makeApp([new FakeProvider("buildkite", [run])])
    internals.setupEventHandlers()

    await handlers.rerun?.(run)

    expect(client.refreshes).toEqual([[run.repo.fullName]])
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
      pollerClient: new FakePollerClient(),
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
      pollerClient: new FakePollerClient(),
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

    const client = new FakePollerClient()
    const app = new App({
      github: fakeGithub,
      dashboard,
      configManager,
      pollerClient: client,
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
    // ...the poller is told not to poll GitHub, but still gets the
    // repositories (Buildkite derives its pipelines from them)...
    expect(client.watches.at(-1)?.github).toBe(false)
    expect(client.watches.at(-1)?.repositories).toEqual(["acme/widgets"])
    // ...repository resolution still went through the GitHub provider...
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
    const client = new FakePollerClient()
    const app = new App({
      github: fakeGithub,
      dashboard,
      configManager,
      pollerClient: client,
      buildkiteFactory: stubBuildkite,
    })
    return { app, rendered, logs, client }
  }

  // M2: an empty grid under --no-buildkite must say why there are no builds.
  test("--no-buildkite adds a single info diagnostic saying so", async () => {
    const { app, rendered, client } = makeInitApp(new IsolatedConfigManager())

    await app.initialize({ repositories: ["acme/widgets"], noBuildkite: true })
    client.emitSnapshot(emptySnapshot())

    const diagnostics = rendered.at(-1)?.diagnostics ?? []
    expect(diagnostics).toEqual([
      { provider: "buildkite", level: "info", message: "Buildkite: disabled (--no-buildkite)" },
    ])
    app.stop()
  })

  test("without --no-buildkite there is no such diagnostic", async () => {
    const { app, rendered, client } = makeInitApp(new IsolatedConfigManager())

    await app.initialize({ repositories: ["acme/widgets"] })
    client.emitSnapshot(emptySnapshot())

    expect(rendered).toHaveLength(1)
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

describe("the shared poller", () => {
  const originalToken = process.env.BUILDKITE_API_TOKEN
  beforeEach(() => {
    delete process.env.BUILDKITE_API_TOKEN
  })
  afterEach(() => {
    if (originalToken === undefined) delete process.env.BUILDKITE_API_TOKEN
    else process.env.BUILDKITE_API_TOKEN = originalToken
  })

  function makePollerApp(github?: Partial<GitHubProvider>) {
    const view = makeDashboard()
    const client = new FakePollerClient()
    const app = new App({
      github: { name: "github", ...github } as unknown as GitHubProvider,
      dashboard: view.dashboard,
      configManager: new IsolatedConfigManager(),
      pollerClient: client,
      buildkiteFactory: stubBuildkite,
    })
    return { app, client, internals: app as unknown as AppInternals, ...view }
  }

  test("the poller is told the repositories, interval and github flag", async () => {
    const { app, client, rendered } = makePollerApp()

    await app.initialize({ repositories: ["acme/widgets"], interval: 7 })

    // Started first, then watched straight away.
    expect(client.calls).toEqual(["start", "watch"])
    expect(client.watches).toEqual([
      { repositories: ["acme/widgets"], interval: 7000, github: true },
    ])
    // The pane fetches no runs itself: nothing renders until a snapshot.
    expect(rendered).toEqual([])
    app.stop()
  })

  test("the Buildkite subscription is what the Buildkite provider was built with", async () => {
    process.env.BUILDKITE_API_TOKEN = "env-token"
    const { app, client } = makePollerApp()

    await app.initialize({ repositories: ["acme/widgets"], bkOrg: "acme", pipelines: ["deploy"] })

    expect(client.watches.at(-1)?.buildkite).toEqual({
      token: "env-token",
      org: "acme",
      pipelines: ["deploy"],
    })
    app.stop()
  })

  test("--no-buildkite leaves Buildkite out of the subscription even with a token", async () => {
    process.env.BUILDKITE_API_TOKEN = "env-token"
    const { app, client } = makePollerApp()

    await app.initialize({ repositories: ["acme/widgets"], noBuildkite: true })

    expect(client.watches.at(-1)?.buildkite).toBeUndefined()
    app.stop()
  })

  test("--no-github sends github: false but still watches the repositories", async () => {
    const { app, client } = makePollerApp()

    await app.initialize({ repositories: ["acme/widgets"], noGithub: true })

    expect(client.watches.at(-1)?.github).toBe(false)
    expect(client.watches.at(-1)?.repositories).toEqual(["acme/widgets"])
    app.stop()
  })

  test("a snapshot renders; an identical second snapshot still goes through tracking", async () => {
    const { app, client, internals, rendered } = makePollerApp()
    await app.initialize({ repositories: ["acme/widgets"] })
    // Finished after ops-hud started, so it counts as having happened while watched.
    const run = makeRun({ status: "failed", createdAt: new Date(Date.now() + 1000).toISOString() })
    const snapshot: Snapshot = {
      ...emptySnapshot(),
      runs: [run],
      jobs: { [run.key]: [makeJob(run.key, "failed")] },
    }

    client.emitSnapshot(snapshot)
    expect(visibleKeys(rendered)).toEqual([run.key])
    expect(rendered.at(-1)?.jobs.get(run.key)).toHaveLength(1)

    // Dismissed, then the very same snapshot again: it is not skipped as a
    // duplicate, and the dismissal applies to it.
    internals.dismissRun(run.key)
    const before = rendered.length
    client.emitSnapshot(snapshot)

    expect(rendered).toHaveLength(before + 1)
    expect(visibleKeys(rendered)).toEqual([])
    app.stop()
  })

  test("budget messages reach the dashboard", async () => {
    const { app, client, budgets, statuses, logs } = makePollerApp()
    await app.initialize({ repositories: ["acme/widgets"] })
    const budget: Budget = {
      provider: "github",
      limit: 5000,
      remaining: 4200,
      resetAt: 1_800_000_000_000,
      stretched: false,
    }

    client.emitBudget(budget)
    client.emitStatus({ mode: "shared", pid: 42, message: "joined the shared poller" })

    expect(budgets).toEqual([budget])
    expect(statuses).toEqual([{ mode: "shared", pid: 42, message: "joined the shared poller" }])
    expect(logs).toContain("joined the shared poller")
    app.stop()
  })

  test("PRs are fetched on their own 30s timer, not per snapshot", async () => {
    let prCalls = 0
    const pr = { number: 1, title: "a PR", createdAt: "2026-09-17T10:00:00Z" }
    const { app, client, rendered } = makePollerApp({
      async getAllPullRequests() {
        prCalls++
        return [pr] as unknown as PullRequest[]
      },
    })
    expect(PR_REFRESH_MS).toBe(30_000)

    await app.initialize({ repositories: ["acme/widgets"], showPRs: true })
    expect(prCalls).toBe(1) // once right away

    client.emitSnapshot(emptySnapshot())
    client.emitSnapshot(emptySnapshot())
    expect(prCalls).toBe(1) // snapshots never fetch PRs

    await app.pollPullRequests()
    expect(prCalls).toBe(2)
    // A PR poll re-renders the last grid with the fresh PRs.
    expect(rendered.at(-1)?.prs).toEqual([pr])
    app.stop()
  })

  test("stop closes the poller client", async () => {
    const { app, client } = makePollerApp()
    await app.initialize({ repositories: ["acme/widgets"] })

    app.stop()

    expect(client.closed).toBe(true)
  })
})

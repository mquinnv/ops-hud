import type { BuildkiteProviderOptions } from "../providers/buildkite.js"
import type { CiReader, FetchResult, ProviderDiagnostic, Scope } from "../providers/types.js"
import type { Job, Run } from "../types.js"
import type { GitHubPoller } from "./github-poller.js"
import {
  type Budget,
  type BuildkiteSubscription,
  IDLE_INTERVAL_MS,
  MIN_INTERVAL_MS,
  type Snapshot,
  type Subscription,
} from "./protocol.js"

export const REFRESH_DEBOUNCE_MS = 2_000
export const BUILDKITE_MIN_INTERVAL_MS = 15_000
export const TICK_MS = 1_000

/** The part of GitHubPoller the core uses, so tests can hand in a fake. */
export type GitHubSource = Pick<
  GitHubPoller,
  "budget" | "poll" | "state" | "isActive" | "forget" | "fetchOlder"
>

export interface CoreDeps {
  github: GitHubSource
  buildkiteFactory: (opts: BuildkiteProviderOptions) => CiReader
  now?: () => number
  /** Told about errors thrown by snapshot or budget listeners, which are otherwise swallowed. */
  onError?: (error: unknown) => void
}

interface Client {
  subscription: Subscription
  /** The last `{runs, jobs, diagnostics}` string sent, for change detection. */
  lastSent?: string
}

/** Shared by repo schedules and Buildkite instances. */
interface Schedule {
  /** When the last poll finished; undefined = never polled, due at once. */
  lastDoneAt?: number
  /** budget.multiplier() as it was when the last poll finished. */
  multiplier: number
  lastRefreshAt?: number
  /** A thrown poll, kept until the next poll succeeds. */
  error?: ProviderDiagnostic
}

interface Instance extends Schedule {
  reader: CiReader
  result?: FetchResult
}

const instanceKey = (bk: BuildkiteSubscription) => `${bk.org ?? ""}\u0000${bk.token}`

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const hasPipelines = (s: Subscription) => (s.buildkite?.pipelines?.length ?? 0) > 0
const isUnscoped = (s: Subscription) => s.repositories.length === 0 && !hasPipelines(s)

export class PollerCore {
  private readonly github: GitHubSource
  private readonly buildkiteFactory: CoreDeps["buildkiteFactory"]
  private readonly now: () => number
  private readonly onError: (error: unknown) => void
  private readonly clients = new Map<string, Client>()
  private readonly repos = new Map<string, Schedule>()
  private readonly instances = new Map<string, Instance>()
  // Keyed outside the replaceable Schedule/Instance, so an unwatch and rewatch
  // during a poll cannot start a second one alongside it.
  private readonly reposInFlight = new Set<string>()
  private readonly instancesInFlight = new Set<string>()
  private readonly snapshotListeners: ((clientId: string, snapshot: Snapshot) => void)[] = []
  private readonly budgetListeners: ((budget: Budget) => void)[] = []
  private lastBudget?: string
  private timer?: ReturnType<typeof setInterval>

  constructor(deps: CoreDeps) {
    this.github = deps.github
    this.buildkiteFactory = deps.buildkiteFactory
    this.now = deps.now ?? Date.now
    this.onError = deps.onError ?? (() => {})
  }

  /** Replaces the client's subscription and sends it a snapshot of the current state at once. */
  subscribe(clientId: string, subscription: Subscription): void {
    this.clients.set(clientId, { subscription })
    this.reconcile()
    this.publish(clientId)
    this.publishBudget()
  }

  unsubscribe(clientId: string): void {
    if (this.clients.delete(clientId)) this.reconcile()
  }

  get clientCount(): number {
    return this.clients.size
  }

  onSnapshot(cb: (clientId: string, snapshot: Snapshot) => void): void {
    this.snapshotListeners.push(cb)
  }

  onBudget(cb: (budget: Budget) => void): void {
    this.budgetListeners.push(cb)
  }

  /** Polls everything due at `now()`; resolves when those polls finish. Never rejects. */
  async tick(): Promise<void> {
    const now = this.now()
    const polls: Promise<void>[] = []
    if (!this.github.budget.paused) {
      for (const [repo, schedule] of this.repos) {
        if (!this.reposInFlight.has(repo) && now >= this.repoDueAt(repo, schedule)) {
          polls.push(this.pollRepo(repo))
        }
      }
    }
    for (const [key, instance] of this.instances) {
      if (!this.instancesInFlight.has(key) && now >= this.instanceDueAt(key, instance)) {
        polls.push(this.pollInstance(key, instance))
      }
    }
    // A pause that lapsed with nothing polled is news to the panes too.
    if (polls.length === 0) this.publishBudget()
    await Promise.all(polls)
  }

  /** Immediate poll of these repos (default: the client's), ignoring the tick but not the pause; max once per 2s per repo. */
  async refresh(clientId: string, repositories?: string[]): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) return
    const now = this.now()
    const fresh = (s: Schedule) =>
      s.lastRefreshAt === undefined || now - s.lastRefreshAt >= REFRESH_DEBOUNCE_MS
    const polls: Promise<void>[] = []
    if (!this.github.budget.paused) {
      for (const repo of repositories ?? client.subscription.repositories) {
        const schedule = this.repos.get(repo)
        if (!schedule || this.reposInFlight.has(repo) || !fresh(schedule)) continue
        schedule.lastRefreshAt = now
        polls.push(this.pollRepo(repo))
      }
    }
    // The client's Buildkite instance too; BuildkiteProvider keeps its own 15s floor.
    const bk = client.subscription.buildkite
    const key = bk && instanceKey(bk)
    const instance = key && this.instances.get(key)
    if (key && instance && !this.instancesInFlight.has(key) && fresh(instance)) {
      instance.lastRefreshAt = now
      polls.push(this.pollInstance(key, instance))
    }
    await Promise.all(polls)
  }

  /** GitHub only: Buildkite has no paging backwards. Never rejects. */
  async older(repositories: string[], before: string, limit: number): Promise<FetchResult> {
    try {
      return await this.github.fetchOlder(repositories, before, limit)
    } catch (error) {
      return {
        runs: [],
        diagnostics: [
          { provider: "github", level: "error", message: `GitHub: ${messageOf(error)}` },
        ],
      }
    }
  }

  start(): void {
    // tick() never rejects; the catch is a backstop, since an unhandled rejection kills the process.
    this.timer ??= setInterval(() => {
      this.tick().catch((error: unknown) => this.onError(error))
    }, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Brings repo schedules and Buildkite instances in line with the current subscriptions. */
  private reconcile(): void {
    const githubRepos = new Set<string>()
    const instanceKeys = new Map<string, BuildkiteSubscription>()
    for (const { subscription } of this.clients.values()) {
      if (subscription.github) for (const repo of subscription.repositories) githubRepos.add(repo)
      if (subscription.buildkite) {
        instanceKeys.set(instanceKey(subscription.buildkite), subscription.buildkite)
      }
    }
    for (const repo of this.repos.keys()) {
      if (githubRepos.has(repo)) continue
      this.repos.delete(repo)
      this.github.forget(repo)
    }
    for (const repo of githubRepos) {
      if (!this.repos.has(repo)) this.repos.set(repo, { multiplier: 1 })
    }
    for (const key of this.instances.keys()) {
      if (!instanceKeys.has(key)) this.instances.delete(key)
    }
    for (const [key, { token, org }] of instanceKeys) {
      if (this.instances.has(key)) continue
      const opts: BuildkiteProviderOptions = org === undefined ? { token } : { token, org }
      this.instances.set(key, {
        reader: this.buildkiteFactory(opts),
        multiplier: 1,
      })
    }
  }

  private subscribers(): Subscription[] {
    return [...this.clients.values()].map((c) => c.subscription)
  }

  /** The fastest interval among the given subscriptions, floored at MIN_INTERVAL_MS. */
  private minInterval(subscriptions: Subscription[]): number {
    const fastest = Math.min(...subscriptions.map((s) => s.interval))
    return Math.max(MIN_INTERVAL_MS, Number.isFinite(fastest) ? fastest : IDLE_INTERVAL_MS)
  }

  /** Computed from today's subscribers, so a departing fast pane slows the repo at once. */
  private repoDueAt(repo: string, schedule: Schedule): number {
    if (schedule.lastDoneAt === undefined) return -Infinity
    const watchers = this.subscribers().filter((s) => s.github && s.repositories.includes(repo))
    const base = this.github.isActive(repo) ? this.minInterval(watchers) : IDLE_INTERVAL_MS
    return schedule.lastDoneAt + base * schedule.multiplier
  }

  private instanceDueAt(key: string, instance: Instance): number {
    if (instance.lastDoneAt === undefined) return -Infinity
    const interval = Math.max(BUILDKITE_MIN_INTERVAL_MS, this.minInterval(this.instanceSubs(key)))
    return instance.lastDoneAt + interval
  }

  private instanceSubs(key: string): Subscription[] {
    return this.subscribers().filter((s) => s.buildkite && instanceKey(s.buildkite) === key)
  }

  /** Explicit slugs where subscribers have them, their repositories where not; any unscoped subscriber makes it org-wide. */
  private scopeOf(key: string): Scope {
    const subs = this.instanceSubs(key)
    if (subs.some(isUnscoped)) return { repositories: [], pipelines: [] }
    const pipelines = new Set<string>()
    const repositories = new Set<string>()
    for (const s of subs) {
      if (hasPipelines(s)) for (const slug of s.buildkite?.pipelines ?? []) pipelines.add(slug)
      else for (const repo of s.repositories) repositories.add(repo)
    }
    return { repositories: [...repositories].sort(), pipelines: [...pipelines].sort() }
  }

  private async pollRepo(repo: string): Promise<void> {
    this.reposInFlight.add(repo)
    let error: ProviderDiagnostic | undefined
    try {
      await this.github.poll(repo)
    } catch (thrown) {
      const message = `GitHub: ${messageOf(thrown)}`
      error = { provider: "github", level: "error", message, repository: repo }
    } finally {
      this.reposInFlight.delete(repo)
    }
    // Whatever schedule the repo has now, which may be a newer one than at the start.
    const schedule = this.repos.get(repo)
    if (!schedule) {
      // Unwatched while in flight: the poll put the repo back, so drop it again.
      this.github.forget(repo)
      return
    }
    schedule.error = error
    schedule.lastDoneAt = this.now()
    schedule.multiplier = this.github.budget.multiplier()
    this.publishAll()
  }

  private async pollInstance(key: string, instance: Instance): Promise<void> {
    this.instancesInFlight.add(key)
    try {
      instance.result = await instance.reader.fetchRuns(this.scopeOf(key))
      instance.error = undefined
    } catch (error) {
      instance.error = {
        provider: "buildkite",
        level: "error",
        message: `Buildkite: ${messageOf(error)}`,
      }
    } finally {
      this.instancesInFlight.delete(key)
      instance.lastDoneAt = this.now()
    }
    // A replaced instance's result is dropped; the new one is due at once.
    if (this.instances.get(key) === instance) this.publishAll()
  }

  private publishAll(): void {
    for (const clientId of this.clients.keys()) this.publish(clientId)
    this.publishBudget()
  }

  /** Sends the client its snapshot if its view changed since the last one sent. */
  private publish(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    const { runs, jobs, diagnostics } = this.buildSnapshot(client.subscription)
    const serialized = JSON.stringify({ runs, jobs, diagnostics })
    if (serialized === client.lastSent) return
    client.lastSent = serialized
    const snapshot: Snapshot = {
      repositories: client.subscription.repositories,
      runs,
      jobs,
      diagnostics,
      budget: this.github.budget.snapshot(),
    }
    for (const listener of this.snapshotListeners) this.notify(() => listener(clientId, snapshot))
  }

  private publishBudget(): void {
    const budget = this.github.budget.snapshot()
    const serialized = JSON.stringify(budget)
    if (serialized === this.lastBudget) return
    this.lastBudget = serialized
    for (const listener of this.budgetListeners) this.notify(() => listener(budget))
  }

  /** A throwing listener must not reject tick() nor starve the listeners after it. */
  private notify(call: () => void): void {
    try {
      call()
    } catch (error) {
      this.onError(error)
    }
  }

  private buildSnapshot(subscription: Subscription): Omit<Snapshot, "repositories" | "budget"> {
    const runs: Run[] = []
    const jobSources: Map<string, Job[]>[] = []
    const diagnostics: ProviderDiagnostic[] = []

    if (subscription.github) {
      for (const repo of subscription.repositories) {
        const state = this.github.state(repo)
        if (state) {
          runs.push(...state.runs)
          jobSources.push(state.jobs)
          diagnostics.push(...state.diagnostics)
        }
        const error = this.repos.get(repo)?.error
        if (error) diagnostics.push(error)
      }
    }

    const instance =
      subscription.buildkite && this.instances.get(instanceKey(subscription.buildkite))
    if (instance) {
      const pipelines = subscription.buildkite?.pipelines ?? []
      const wanted = (run: Run) => {
        if (isUnscoped(subscription)) return true
        if (pipelines.length > 0)
          return run.pipelineSlug !== undefined && pipelines.includes(run.pipelineSlug)
        return subscription.repositories.includes(run.repo.fullName)
      }
      if (instance.result) {
        runs.push(...instance.result.runs.filter(wanted))
        if (instance.result.jobs) jobSources.push(instance.result.jobs)
        diagnostics.push(...instance.result.diagnostics)
      }
      if (instance.error) diagnostics.push(instance.error)
    }

    runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    const jobs: Record<string, Job[]> = {}
    for (const run of runs) {
      const found = jobSources.find((source) => source.has(run.key))?.get(run.key)
      if (found) jobs[run.key] = found
    }
    const seen = new Set<string>()
    const relevant = diagnostics.filter((d) => {
      if (d.repository && !subscription.repositories.includes(d.repository)) return false
      if (seen.has(d.message)) return false
      seen.add(d.message)
      return true
    })
    return { runs, jobs, diagnostics: relevant }
  }
}

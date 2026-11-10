import {
  type GitHubJobPayload,
  type GitHubRunPayload,
  mapGitHubJob,
  mapGitHubRun,
} from "../providers/github-map.js"
import type { FetchResult, ProviderDiagnostic } from "../providers/types.js"
import { isActive as isActiveStatus, isTerminal } from "../status.js"
import type { Job, Run } from "../types.js"
import { isRateLimitResponse, RateBudget } from "./budget.js"

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export type TokenResolver = () => Promise<string | undefined>

export interface RepoState {
  runs: Run[]
  /** Jobs of the current attempt, keyed by Run.key. */
  jobs: Map<string, Job[]>
  diagnostics: ProviderDiagnostic[]
}

export const GITHUB_API = "https://api.github.com"
export const MAX_IN_FLIGHT = 4
export const TOKEN_RETRY_MS = 60_000
export const RUNS_PER_PAGE = 20
export const REQUEST_TIMEOUT_MS = 30_000

const RATE_LIMITED = "GitHub: API rate limit exceeded"
const NOT_LOGGED_IN = "GitHub: not logged in — run gh auth login"

/** GH_TOKEN, then GITHUB_TOKEN, then `gh auth token` (via the injected runner). */
export async function resolveGitHubToken(
  env: Record<string, string | undefined>,
  run: (file: string, args: string[]) => Promise<{ stdout: string }>,
): Promise<string | undefined> {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = env[name]?.trim()
    if (value) return value
  }
  try {
    const { stdout } = await run("gh", ["auth", "token"])
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

type Outcome =
  | { kind: "ok"; etag?: string; body: unknown }
  | { kind: "not-modified" }
  | { kind: "rate-limited" }
  | { kind: "unauthorized" }
  | { kind: "error"; reason: string }

/** A promise semaphore: at most `max` tasks run at once, the rest wait in order. */
class Limiter {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++
    // The releasing task hands its slot straight over, so `active` stays put.
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

interface JobsEntry {
  etag?: string
  jobs?: Job[]
  /** Set once the run has finished and its jobs were read after that; never fetched again. */
  final: boolean
}

interface TrackedRepo {
  etag?: string
  raw: GitHubRunPayload[]
  runs: Run[]
  /** Keyed by `${run.id}:${run_attempt}`, so a rerun starts afresh. */
  jobs: Map<string, JobsEntry>
  diagnostics: ProviderDiagnostic[]
}

const jobsKey = (raw: GitHubRunPayload) => `${raw.id}:${raw.run_attempt ?? 1}`

function diagnostic(repository: string, message: string): ProviderDiagnostic {
  return { provider: "github", level: "error", message, repository }
}

/** GitHub's JSON error bodies carry a `message`; anything else says nothing useful. */
function messageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown }
    return typeof parsed?.message === "string" ? parsed.message : ""
  } catch {
    return ""
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
  }
  const text = error instanceof Error ? error.message : String(error)
  return text.split("\n", 1)[0].trim().slice(0, 120) || "request failed"
}

export class GitHubPoller {
  readonly budget: RateBudget

  private readonly fetch: FetchLike
  private readonly now: () => number
  private readonly resolveToken: TokenResolver
  private readonly limiter = new Limiter(MAX_IN_FLIGHT)
  private readonly repos = new Map<string, TrackedRepo>()
  private token?: string
  private lastResolveAt?: number
  private resolving?: Promise<string | undefined>

  constructor(opts: { fetch?: FetchLike; now?: () => number; resolveToken: TokenResolver }) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init))
    this.now = opts.now ?? Date.now
    this.resolveToken = opts.resolveToken
    this.budget = new RateBudget(this.now)
  }

  /** "ok" once a token resolved; "unauthenticated" before, and after a 401 until re-resolution succeeds. */
  get authState(): "ok" | "unauthenticated" {
    return this.token ? "ok" : "unauthenticated"
  }

  /** Run list (conditional) then jobs for active runs (conditional) and once more for runs that just finished. Never throws. */
  async poll(repo: string): Promise<{ changed: boolean }> {
    let tracked = this.repos.get(repo)
    if (!tracked) {
      tracked = { raw: [], runs: [], jobs: new Map(), diagnostics: [] }
      this.repos.set(repo, tracked)
    }
    // Paused: send nothing, and keep what we had, diagnostic included.
    if (this.budget.paused) return { changed: false }
    if (!(await this.ensureToken())) {
      tracked.diagnostics = [diagnostic(repo, NOT_LOGGED_IN)]
      return { changed: false }
    }

    let changed = false
    const list = await this.request(
      `${GITHUB_API}/repos/${repo}/actions/runs?per_page=${RUNS_PER_PAGE}`,
      tracked.etag,
    )
    if (list.kind === "ok") {
      const raw = (list.body as { workflow_runs?: GitHubRunPayload[] }).workflow_runs ?? []
      tracked.etag = list.etag
      tracked.raw = raw
      tracked.runs = raw.map(mapGitHubRun)
      const present = new Set(raw.map(jobsKey))
      for (const key of tracked.jobs.keys()) if (!present.has(key)) tracked.jobs.delete(key)
      changed = true
    } else if (list.kind !== "not-modified") {
      tracked.diagnostics = [this.failure(list, repo, `GitHub: could not list runs for ${repo}`)]
      return { changed: false }
    }

    const current = tracked
    const results = await Promise.all(
      current.raw.map((raw, i) => this.pollJobs(repo, current, raw, current.runs[i])),
    )
    const diagnostics: ProviderDiagnostic[] = []
    for (const result of results) {
      if (result === true) changed = true
      else if (result && !diagnostics.some((d) => d.message === result.message)) {
        diagnostics.push(result)
      }
    }
    current.diagnostics = diagnostics
    return { changed }
  }

  state(repo: string): RepoState | undefined {
    const tracked = this.repos.get(repo)
    if (!tracked) return undefined
    const jobs = new Map<string, Job[]>()
    tracked.raw.forEach((raw, i) => {
      const entry = tracked.jobs.get(jobsKey(raw))
      if (entry?.jobs) jobs.set(tracked.runs[i].key, entry.jobs)
    })
    return { runs: tracked.runs, jobs, diagnostics: tracked.diagnostics }
  }

  isActive(repo: string): boolean {
    return this.repos.get(repo)?.runs.some((run) => isActiveStatus(run.status)) ?? false
  }

  forget(repo: string): void {
    this.repos.delete(repo)
  }

  /** `created=<before`, newest first, sliced to limit. Counted in the budget; respects pause. */
  async fetchOlder(repositories: string[], before: string, limit: number): Promise<FetchResult> {
    if (!this.budget.paused) await this.ensureToken()
    const created = encodeURIComponent(`<${before}`)
    const runs: Run[] = []
    const diagnostics: ProviderDiagnostic[] = []
    await Promise.all(
      repositories.map(async (repo) => {
        const outcome = await this.request(
          `${GITHUB_API}/repos/${repo}/actions/runs?per_page=${limit}&created=${created}`,
        )
        if (outcome.kind === "ok") {
          const raw = (outcome.body as { workflow_runs?: GitHubRunPayload[] }).workflow_runs ?? []
          runs.push(...raw.map(mapGitHubRun))
        } else if (outcome.kind !== "not-modified") {
          // "No older runs" and "could not look" must not read alike.
          diagnostics.push(
            this.failure(outcome, repo, `GitHub: could not list older runs for ${repo}`),
          )
        }
      }),
    )
    runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return { runs: runs.slice(0, limit), diagnostics }
  }

  /**
   * One run's jobs, if it still needs them: true when a 200 arrived, a
   * diagnostic when the read failed, undefined otherwise.
   */
  private async pollJobs(
    repo: string,
    tracked: TrackedRepo,
    raw: GitHubRunPayload,
    run: Run,
  ): Promise<true | ProviderDiagnostic | undefined> {
    const key = jobsKey(raw)
    const finished = isTerminal(run.status)
    let entry = tracked.jobs.get(key)
    if (!entry) {
      // Already finished when first seen: its jobs are not worth a request.
      entry = { final: finished }
      tracked.jobs.set(key, entry)
    }
    if (entry.final) return undefined

    const outcome = await this.request(
      `${GITHUB_API}/repos/${repo}/actions/runs/${raw.id}/jobs`,
      entry.etag,
    )
    if (outcome.kind === "ok") {
      const jobs = (outcome.body as { jobs?: GitHubJobPayload[] }).jobs ?? []
      entry.etag = outcome.etag
      entry.jobs = jobs.map((job) => mapGitHubJob(job, run.key))
      if (finished) entry.final = true
      return true
    }
    if (outcome.kind === "not-modified") {
      if (finished) entry.final = true
      return undefined
    }
    return this.failure(outcome, repo, `GitHub: could not list jobs for ${repo}`)
  }

  private failure(
    outcome: Exclude<Outcome, { kind: "ok" } | { kind: "not-modified" }>,
    repo: string,
    fallback: string,
  ): ProviderDiagnostic {
    switch (outcome.kind) {
      case "rate-limited":
        return diagnostic(repo, RATE_LIMITED)
      case "unauthorized":
        return diagnostic(repo, NOT_LOGGED_IN)
      case "error":
        return diagnostic(repo, `${fallback} — ${outcome.reason}`)
    }
  }

  /** The held token; with none, resolves one at most once per TOKEN_RETRY_MS. */
  private async ensureToken(): Promise<string | undefined> {
    if (this.token) return this.token
    if (this.lastResolveAt !== undefined && this.now() - this.lastResolveAt < TOKEN_RETRY_MS) {
      return undefined
    }
    const token = await this.resolveOnce()
    this.token ??= token
    return this.token
  }

  /** Concurrent callers share one resolution (one `gh auth token`, not four). */
  private resolveOnce(): Promise<string | undefined> {
    this.resolving ??= (async () => {
      this.lastResolveAt = this.now()
      try {
        return (await this.resolveToken())?.trim() || undefined
      } catch {
        return undefined
      }
    })().finally(() => {
      this.resolving = undefined
    })
    return this.resolving
  }

  /** After a 401 with `rejected`: one re-resolution; a missing or identical token means logged out. */
  private async reauthenticate(rejected: string): Promise<string | undefined> {
    if (this.token !== rejected) return this.token
    const fresh = await this.resolveOnce()
    if (this.token === rejected) this.token = fresh && fresh !== rejected ? fresh : undefined
    return this.token
  }

  /** A request with the held token; a 401 re-resolves once and retries once. */
  private async request(url: string, etag?: string): Promise<Outcome> {
    const used = this.token
    if (!used) return { kind: "unauthorized" }
    const outcome = await this.send(url, used, etag)
    if (outcome.kind !== "unauthorized") return outcome
    const fresh = await this.reauthenticate(used)
    if (!fresh) return outcome
    const retried = await this.send(url, fresh, etag)
    if (retried.kind === "unauthorized" && this.token === fresh) this.token = undefined
    return retried
  }

  private send(url: string, token: string, etag?: string): Promise<Outcome> {
    return this.limiter.run(async (): Promise<Outcome> => {
      // A limit hit by a request ahead in the queue stops the rest from going out.
      if (this.budget.paused) return { kind: "rate-limited" }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }
      if (etag) headers["If-None-Match"] = etag
      try {
        const response = await this.fetch(url, {
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        this.budget.record(response.headers)
        if (response.status === 304) return { kind: "not-modified" }
        const text = await response.text()
        if (response.status === 401) return { kind: "unauthorized" }
        if (isRateLimitResponse(response.status, response.headers, text)) {
          this.budget.recordLimitHit(response.headers)
          return { kind: "rate-limited" }
        }
        if (!response.ok) {
          const reason = messageOf(text) || response.statusText
          return { kind: "error", reason: `${response.status} ${reason}`.trim() }
        }
        try {
          return {
            kind: "ok",
            etag: response.headers.get("etag") ?? undefined,
            body: JSON.parse(text),
          }
        } catch {
          return { kind: "error", reason: "unreadable response" }
        }
      } catch (error) {
        return { kind: "error", reason: describeError(error) }
      }
    })
  }
}

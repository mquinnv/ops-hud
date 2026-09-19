import { fromBuildkiteJob } from "../status.js"
import type { Job, Run } from "../types.js"
import {
  type BuildkiteBuildPayload,
  type BuildkiteJobPayload,
  type BuildkitePipelinePayload,
  indexPipelinesByRepo,
  isDisplayableJob,
  mapBuildkiteBuild,
  mapBuildkiteJob,
} from "./buildkite-map.js"
import type { CiProvider, FetchResult, ProviderDiagnostic, Scope } from "./types.js"

const API = "https://api.buildkite.com/v2"
/** The token is only ever sent to this origin — never to a Link header or a
 * log_url that happens to point somewhere else. */
const API_ORIGIN = "https://api.buildkite.com/"

/** How often the pipeline index is refreshed — pipelines change far more slowly than builds. */
const PIPELINE_INDEX_TTL_MS = 5 * 60 * 1000

// Buildkite's REST API allows 50 requests/minute per user, and that budget is
// shared with every other client using the same token. The dashboard refreshes
// every 5s, so one request per pipeline per refresh is 12/min per pipeline:
// five pipelines alone blow the limit. Up to this many slugs, per-pipeline
// requests are cheap enough and give per-pipeline error diagnostics; beyond it,
// a single org-wide request filtered client-side costs one request no matter
// how many pipelines are in scope.
const MAX_PER_PIPELINE_SLUGS = 2

/** The org-wide window: wide enough that a filtered scope still sees its builds. */
const ORG_WIDE_PER_PAGE = 100

// A minimum spacing between network fetches of builds. This deliberately
// reverses the earlier "no builds cache" decision: at the 5s refresh interval
// even a single request per refresh is 12/min, a quarter of the shared budget.
// A call inside the window gets the previous result (runs, jobs and
// diagnostics) back without any request.
const MIN_FETCH_INTERVAL_MS = 15_000

/** Backoff after a 429 that names no reset time, in seconds. */
const DEFAULT_RATE_LIMIT_RESET_S = 60

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface BuildkiteProviderOptions {
  token?: string
  /** Auto-detected when the token reaches exactly one organization. */
  org?: string
  /**
   * Explicit pipeline slugs. Non-empty wins over deriving slugs from
   * `Scope.repositories`, in both scoped and unscoped modes.
   */
  pipelines?: string[]
  /** Injectable so tests never touch the network. */
  fetch?: FetchLike
  /**
   * Testing seam for the pipeline index TTL, the minimum fetch interval and
   * 429 backoff. Defaults to `Date.now`.
   */
  now?: () => number
}

export function resolveBuildkiteToken(
  env: Record<string, string | undefined>,
  config: { token?: string } | undefined,
): string | undefined {
  const fromEnv = env.BUILDKITE_API_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = config?.token?.trim()
  return fromConfig ? fromConfig : undefined
}

/** Extracts the rel="next" URL from an RFC 5988 Link header. */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}

/** Which token scope a request needs, so a 401/403 can name the missing one. */
type TokenScope = "read" | "write" | "logs" | "orgs"

const SCOPES_NEEDED: Record<TokenScope, string> = {
  read: "read_builds, read_pipelines",
  write: "write_builds",
  logs: "read_build_logs",
  // Only org auto-detection lists organizations; naming the org skips it.
  orgs: "read_organizations, or set buildkite.org to skip auto-detection",
}

/** A token that is present but rejected by the API (401/403) — must be loud. */
export class TokenRejected extends Error {
  constructor(scope: TokenScope = "read") {
    super(`token rejected — check scopes (needs ${SCOPES_NEEDED[scope]})`)
  }
}

class AmbiguousOrganization extends Error {
  constructor(slugs: string[]) {
    super(`several orgs reachable (${slugs.join(", ")}) — set buildkite.org or --bk-org`)
  }
}

class NoOrganizations extends Error {
  constructor() {
    super("token reaches no organizations")
  }
}

/**
 * A 429. Its own class: being throttled says nothing about the token, so it
 * must never be reported as a rejected one.
 */
class RateLimited extends Error {
  constructor(remainingMs: number) {
    super(`rate limited — retrying in ${Math.ceil(Math.max(0, remainingMs) / 1000)}s`)
  }
}

/** Seconds until a 429 lifts: the user-scoped header, the org-scoped one, the body, else 60. */
async function rateLimitResetSeconds(response: Response): Promise<number> {
  for (const header of ["RateLimit-User-Reset", "RateLimit-Reset"]) {
    const value = Number(response.headers.get(header))
    if (response.headers.get(header) !== null && Number.isFinite(value) && value >= 0) {
      return value
    }
  }
  try {
    const body = (await response.json()) as { reset?: unknown }
    const reset = Number(body?.reset)
    if (body?.reset !== undefined && body?.reset !== null && Number.isFinite(reset) && reset >= 0) {
      return reset
    }
  } catch {
    // No JSON body: fall through to the default.
  }
  return DEFAULT_RATE_LIMIT_RESET_S
}

/** A non-auth HTTP failure. `path` is the request path only — never the token. */
class HttpError extends Error {
  constructor(status: number, path: string) {
    super(`HTTP ${status} from ${path}`)
  }
}

/** Picks the job whose log actually explains a failure, not the pipeline upload. */
function pickLogJob(jobs: BuildkiteJobPayload[]): BuildkiteJobPayload | undefined {
  const failed = jobs.find((job) => {
    if (!job.log_url) return false
    const status = fromBuildkiteJob(job.state, job.soft_failed === true)
    return status === "failed" || status === "timed_out"
  })
  if (failed) return failed

  const withLog = jobs.filter((job) => job.log_url)
  return withLog.length > 0 ? withLog[withLog.length - 1] : undefined
}

export class BuildkiteProvider implements CiProvider {
  readonly name = "buildkite"

  private readonly token?: string
  private readonly configuredOrg?: string
  private readonly explicitPipelines: string[]
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly limit = 20

  private resolvedOrg?: string
  private pipelineIndex?: { index: Map<string, string[]>; timestamp: number }
  /** The most recent network fetch of builds: when it began, and what it returned. */
  private lastFetch?: { startedAt: number; scopeKey: string; result: FetchResult }
  /** The most recent fetch that was not rate limited — shown while backing off. */
  private lastGood?: FetchResult
  /** No Buildkite request is made before this time (epoch ms) after a 429. */
  private rateLimitedUntil?: number

  constructor(options: BuildkiteProviderOptions) {
    const trimmed = options.token?.trim()
    this.token = trimmed ? trimmed : undefined
    this.configuredOrg = options.org
    this.explicitPipelines = options.pipelines ?? []
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
  }

  async fetchRuns(scope: Scope): Promise<FetchResult> {
    if (!this.token) {
      return {
        runs: [],
        diagnostics: [
          {
            provider: "buildkite",
            level: "info",
            message: "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
          },
        ],
      }
    }

    const now = this.now()
    const scopeKey = scope.repositories.join(",")
    if (
      this.lastFetch &&
      this.lastFetch.scopeKey === scopeKey &&
      now - this.lastFetch.startedAt < MIN_FETCH_INTERVAL_MS
    ) {
      return this.lastFetch.result
    }
    if (this.isBackingOff()) {
      return this.rateLimitedResult()
    }

    this.lastFetch = { startedAt: now, scopeKey, result: { runs: [], diagnostics: [] } }
    let result: FetchResult
    try {
      result = await this.fetchRunsFromNetwork(scope)
      this.lastGood = result
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error
      result = this.rateLimitedResult()
    }
    this.lastFetch.result = result
    return result
  }

  private isBackingOff(): boolean {
    return this.rateLimitedUntil !== undefined && this.now() < this.rateLimitedUntil
  }

  /** The last good runs and jobs, with exactly one diagnostic saying why they are stale. */
  private rateLimitedResult(): FetchResult {
    const remaining = (this.rateLimitedUntil ?? this.now()) - this.now()
    return {
      runs: this.lastGood?.runs ?? [],
      jobs: this.lastGood?.jobs,
      diagnostics: [this.diagnoseFetchError(new RateLimited(remaining))],
    }
  }

  /** One real fetch. Throws only RateLimited; every other failure is a diagnostic. */
  private async fetchRunsFromNetwork(scope: Scope): Promise<FetchResult> {
    let org: string
    try {
      org = await this.resolveOrg()
    } catch (error) {
      if (error instanceof RateLimited) throw error
      return { runs: [], diagnostics: [this.diagnoseFetchError(error)] }
    }

    const diagnostics: ProviderDiagnostic[] = []
    // A configured pipeline list wins over deriving slugs from the scope, in
    // both scoped and unscoped modes — it never touches the index.
    let slugs: string[] | undefined
    if (this.explicitPipelines.length > 0) {
      slugs = this.explicitPipelines
    } else if (scope.repositories.length > 0) {
      let index: Map<string, string[]>
      try {
        index = await this.getPipelineIndex(org)
      } catch (error) {
        if (error instanceof RateLimited) throw error
        return { runs: [], diagnostics: [this.diagnoseFetchError(error)] }
      }
      slugs = []
      for (const repo of scope.repositories) {
        const repoSlugs = index.get(repo)
        if (!repoSlugs || repoSlugs.length === 0) {
          diagnostics.push({
            provider: "buildkite",
            level: "info",
            message: `Buildkite: no pipeline in ${org} builds ${repo}`,
          })
          continue
        }
        slugs.push(...repoSlugs)
      }
    }
    // Otherwise `slugs` stays undefined: unscoped, org-wide.

    const builds: BuildkiteBuildPayload[] = []
    if (slugs && slugs.length <= MAX_PER_PIPELINE_SLUGS) {
      for (const slug of slugs) {
        try {
          builds.push(
            ...(await this.getPage<BuildkiteBuildPayload>(
              // `per_page` is a window of the N most recent builds, not
              // something to paginate through — one page, ever. Never
              // `exclude_jobs`: embedded jobs are how fetchRuns returns them
              // for free.
              `/organizations/${org}/pipelines/${slug}/builds?per_page=${this.limit}`,
            )),
          )
        } catch (error) {
          // A 429 stops the loop: every further request would be refused too.
          if (error instanceof RateLimited) throw error
          // Caught per slug so one bad pipeline doesn't hide the rest.
          diagnostics.push(this.diagnoseFetchError(error))
        }
      }
    } else {
      // Unscoped, or too many pipelines to afford one request each: one
      // org-wide request, filtered here to the pipelines in scope.
      const wanted = slugs ? new Set(slugs) : undefined
      try {
        const page = await this.getPage<BuildkiteBuildPayload>(
          `/organizations/${org}/builds?per_page=${ORG_WIDE_PER_PAGE}`,
        )
        builds.push(...(wanted ? page.filter((b) => wanted.has(b.pipeline?.slug)) : page))
      } catch (error) {
        if (error instanceof RateLimited) throw error
        diagnostics.push(this.diagnoseFetchError(error))
      }
    }

    const runs: Run[] = []
    const jobs = new Map<string, Job[]>()
    for (const raw of builds) {
      try {
        const run = mapBuildkiteBuild(raw)
        const runJobs = raw.jobs
          .filter(isDisplayableJob)
          .map((job) => mapBuildkiteJob(job, run.key))
        runs.push(run)
        jobs.set(run.key, runJobs)
      } catch (error) {
        // A malformed build (e.g. missing `jobs`) is a diagnostic, not a
        // reason to fail the whole refresh.
        diagnostics.push(this.diagnoseFetchError(error))
      }
    }

    return { runs, jobs, diagnostics }
  }

  /** Jobs always arrive embedded in the build payload — fetchRuns already has them. */
  async fetchJobs(_run: Run): Promise<Job[]> {
    return []
  }

  async cancel(run: Run): Promise<void> {
    const slug = this.requireSlug(run)
    const org = await this.resolveOrg()
    // PUT is what the Buildkite REST reference documents (with a matching curl
    // example); unverified against the live API — no token is available here.
    await this.write(`/organizations/${org}/pipelines/${slug}/builds/${run.number}/cancel`)
  }

  async rerun(run: Run): Promise<void> {
    const slug = this.requireSlug(run)
    const org = await this.resolveOrg()
    // PUT per the REST reference, same caveat as cancel — unverified live.
    await this.write(`/organizations/${org}/pipelines/${slug}/builds/${run.number}/rebuild`)
  }

  async logs(run: Run): Promise<string> {
    const slug = this.requireSlug(run)
    const org = await this.resolveOrg()
    const build = await this.getOne<BuildkiteBuildPayload>(
      `/organizations/${org}/pipelines/${slug}/builds/${run.number}`,
    )
    const job = pickLogJob(build.jobs ?? [])
    if (!job?.log_url) return ""

    // Log text needs its own scope; a 403 here must say so, not blame read_builds.
    const response = await this.request(job.log_url, undefined, "logs")
    const payload = (await response.json()) as { content?: string }
    return payload.content ?? ""
  }

  private requireSlug(run: Run): string {
    if (!run.pipelineSlug) {
      throw new Error(`Buildkite: run ${run.key} has no pipeline slug`)
    }
    return run.pipelineSlug
  }

  private async resolveOrg(): Promise<string> {
    if (this.resolvedOrg) return this.resolvedOrg
    if (this.configuredOrg) {
      this.resolvedOrg = this.configuredOrg
      return this.resolvedOrg
    }

    // Not cached on failure: a bad lookup must retry on the next refresh.
    const orgs = await this.getAll<{ slug: string }>("/organizations", "orgs")
    if (orgs.length === 1) {
      this.resolvedOrg = orgs[0].slug
      return this.resolvedOrg
    }
    if (orgs.length === 0) throw new NoOrganizations()
    throw new AmbiguousOrganization(orgs.map((o) => o.slug))
  }

  private async getPipelineIndex(org: string): Promise<Map<string, string[]>> {
    const now = this.now()
    if (this.pipelineIndex && now - this.pipelineIndex.timestamp < PIPELINE_INDEX_TTL_MS) {
      return this.pipelineIndex.index
    }
    // Not cached on failure, same reasoning as resolveOrg.
    const pipelines = await this.getAll<BuildkitePipelinePayload>(
      `/organizations/${org}/pipelines?per_page=100`,
    )
    const index = indexPipelinesByRepo(pipelines)
    this.pipelineIndex = { index, timestamp: now }
    return index
  }

  /**
   * A paginating GET that follows `Link: rel="next"` across an array
   * response. Only for `/organizations` and the pipeline index — builds use
   * `getPage`, exactly once, regardless of any Link header they carry.
   */
  private async getAll<T>(path: string, tokenScope: TokenScope = "read"): Promise<T[]> {
    const out: T[] = []
    let url: string | undefined = path.startsWith("http") ? path : `${API}${path}`
    while (url) {
      const response = await this.request(url, undefined, tokenScope)
      out.push(...((await response.json()) as T[]))
      url = nextLink(response.headers.get("link"))
    }
    return out
  }

  /**
   * A single-page GET for an array response. Builds only: `per_page` is a
   * window of the N most recent builds, not something to exhaust by
   * following `Link: rel="next"` — that would walk the entire build history
   * every refresh.
   */
  private async getPage<T>(path: string): Promise<T[]> {
    const response = await this.request(`${API}${path}`)
    return (await response.json()) as T[]
  }

  /** A GET for a single-object response, e.g. one build. */
  private async getOne<T>(path: string): Promise<T> {
    const response = await this.request(`${API}${path}`)
    return (await response.json()) as T
  }

  private async write(path: string): Promise<void> {
    await this.request(`${API}${path}`, { method: "PUT" }, "write")
  }

  /**
   * The one place a request actually goes out. Refuses to send the token
   * anywhere but the Buildkite API — a `Link` header or a job's `log_url`
   * pointing elsewhere must not receive it.
   */
  private async request(
    url: string,
    init?: RequestInit,
    tokenScope: TokenScope = "read",
  ): Promise<Response> {
    if (!url.startsWith(API_ORIGIN)) {
      throw new Error(`refusing to send the token to an unexpected host: ${url}`)
    }
    // While backing off from a 429, no request goes out at all.
    if (this.isBackingOff()) {
      throw new RateLimited((this.rateLimitedUntil ?? 0) - this.now())
    }
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${this.token}` },
    })
    if (response.status === 429) {
      const resetMs = (await rateLimitResetSeconds(response)) * 1000
      this.rateLimitedUntil = this.now() + resetMs
      throw new RateLimited(resetMs)
    }
    if (response.status === 401 || response.status === 403) {
      throw new TokenRejected(tokenScope)
    }
    if (!response.ok) {
      const path = url.startsWith(API) ? url.slice(API.length) : url
      throw new HttpError(response.status, path)
    }
    return response
  }

  private diagnoseFetchError(error: unknown): ProviderDiagnostic {
    const message = error instanceof Error ? error.message : String(error)
    return { provider: "buildkite", level: "error", message: `Buildkite: ${message}` }
  }
}

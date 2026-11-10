import type { Job, Run } from "../types.js"

export interface Scope {
  /** "owner/repo" entries. */
  repositories: string[]
  /** Explicit pipeline slugs (Buildkite); replaces the provider's configured list. */
  pipelines?: string[]
}

/** Why a provider contributed nothing, for the log pane and empty state. */
export interface ProviderDiagnostic {
  provider: string
  level: "info" | "error"
  message: string
  /** "owner/repo" the diagnostic is about, when it is about one. */
  repository?: string
}

export interface FetchResult {
  runs: Run[]
  /**
   * Jobs keyed by Run.key, when the provider got them for free. Buildkite
   * embeds jobs in its build payloads; GitHub needs a call per run and
   * leaves this undefined.
   */
  jobs?: Map<string, Job[]>
  diagnostics: ProviderDiagnostic[]
}

/** The pane-side, user-initiated operations. Both providers implement this. */
export interface CiProvider {
  readonly name: string
  cancel(run: Run): Promise<void>
  rerun(run: Run): Promise<void>
  logs(run: Run): Promise<string>
}

/** The read path. Lives in the poller process. BuildkiteProvider implements it; GitHubProvider stops doing so in Task 9. */
export interface CiReader {
  readonly name: string
  fetchRuns(scope: Scope): Promise<FetchResult>
  fetchJobs(run: Run): Promise<Job[]>
}

/**
 * What App holds until Task 9 rewrites it. `fetchOlderRuns` is optional: only
 * GitHub can page backwards, and one that omits it sits resurrect out.
 */
export type CiSource = CiProvider &
  CiReader & {
    fetchOlderRuns?(scope: Scope, before: string, limit: number): Promise<FetchResult>
  }

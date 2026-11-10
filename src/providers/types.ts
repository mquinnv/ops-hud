import type { Job, Run } from "../types.js"

export interface Scope {
  /** "owner/repo" entries. */
  repositories: string[]
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

export interface CiProvider {
  readonly name: string
  fetchRuns(scope: Scope): Promise<FetchResult>
  fetchJobs(run: Run): Promise<Job[]>
  cancel(run: Run): Promise<void>
  rerun(run: Run): Promise<void>
  logs(run: Run): Promise<string>
  /**
   * Runs older than `before`, newest first, with diagnostics for whatever the
   * provider could not read — a rate-limited resurrect must not look like a
   * resurrect that found nothing. Optional: not every provider can page
   * backwards through history, and one that omits this simply does not
   * participate in resurrect.
   */
  fetchOlderRuns?(scope: Scope, before: string, limit: number): Promise<FetchResult>
}

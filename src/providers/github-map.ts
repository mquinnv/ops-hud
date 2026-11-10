import { fromGitHub, isTerminal } from "../status.js"
import type { Job, Run, Step } from "../types.js"

// Shapes of the `gh api repos/{owner}/{repo}/actions/runs` and
// `.../runs/{id}/jobs` responses — only the fields we actually read.

export interface GitHubRunPayload {
  id: number
  name?: string
  display_title?: string
  head_branch: string
  head_sha: string
  run_number: number
  run_attempt?: number
  event?: string
  run_started_at?: string
  status: string
  conclusion?: string | null
  workflow_id: number
  html_url: string
  created_at: string
  updated_at: string
  repository: { full_name: string; owner: { login: string }; name: string }
  actor?: { login: string }
  head_commit?: { message: string; author?: { name: string } }
}

export interface GitHubStepPayload {
  name: string
  status: string
  conclusion?: string | null
  number: number
  started_at?: string | null
  completed_at?: string | null
}

export interface GitHubJobPayload {
  id: number
  name: string
  status: string
  conclusion?: string | null
  started_at?: string | null
  completed_at?: string | null
  html_url?: string
  runner_name?: string | null
  steps?: GitHubStepPayload[]
}

/** First line of a commit message; the card has one line to spend. */
function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim()
}

export function mapGitHubRun(raw: GitHubRunPayload): Run {
  const fullName = raw.repository.full_name
  const [owner, name] = fullName.split("/")
  const id = String(raw.id)
  const commitMessage = raw.head_commit?.message
  const status = fromGitHub(raw.status, raw.conclusion)

  return {
    provider: "github",
    key: `github:${fullName}:${id}`,
    id,
    number: raw.run_number,
    title: commitMessage ? firstLine(commitMessage) : (raw.display_title ?? raw.name ?? ""),
    pipeline: raw.name ?? "",
    branch: raw.head_branch,
    sha: raw.head_sha,
    status,
    isFailing: false,
    repo: { owner, name, fullName },
    actor: raw.actor?.login,
    event: raw.event,
    commitMessage,
    webUrl: raw.html_url,
    createdAt: raw.created_at,
    startedAt: raw.run_started_at ?? undefined,
    // GitHub has no finished_at; updated_at is the last write, which for a run
    // that has reached a verdict is when it finished.
    finishedAt: isTerminal(status) ? raw.updated_at : undefined,
  }
}

function mapStep(raw: GitHubStepPayload): Step {
  return {
    name: raw.name,
    status: fromGitHub(raw.status, raw.conclusion),
    number: raw.number,
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.completed_at ?? undefined,
  }
}

export function mapGitHubJob(raw: GitHubJobPayload, runKey: string): Job {
  const id = String(raw.id)

  return {
    id,
    key: `${runKey}:${id}`,
    runKey,
    name: raw.name,
    status: fromGitHub(raw.status, raw.conclusion),
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.completed_at ?? undefined,
    agent: raw.runner_name ?? undefined,
    webUrl: raw.html_url,
    steps: raw.steps?.map(mapStep),
  }
}

/**
 * A run that is still going but already has a failed job is doomed. Buildkite
 * reports this directly as the `failing` state; for GitHub it has to be
 * derived. Only meaningful while the run is in flight — a finished run already
 * carries its verdict in `status`.
 */
export function applyIsFailing(run: Run, jobs: Job[]): Run {
  if (isTerminal(run.status)) return run
  const failing = jobs.some((j) => j.status === "failed" || j.status === "timed_out")
  return failing ? { ...run, isFailing: true } : run
}

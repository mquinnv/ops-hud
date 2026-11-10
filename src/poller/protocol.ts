import { join } from "node:path"
import type { ProviderDiagnostic } from "../providers/types.js"
import type { Job, Run } from "../types.js"

export interface BuildkiteSubscription {
  token: string
  org?: string
  pipelines?: string[]
}

export interface Subscription {
  repositories: string[]
  /** ms; the poller floors it at MIN_INTERVAL_MS */
  interval: number
  /** false = --no-github: repositories are used for Buildkite derivation only */
  github: boolean
  buildkite?: BuildkiteSubscription
}

export interface Budget {
  provider: "github"
  limit: number
  remaining: number
  /** epoch ms */
  resetAt: number
  /** epoch ms, present only while paused */
  pausedUntil?: number
  stretched: boolean
}

export interface Snapshot {
  repositories: string[]
  runs: Run[]
  /** keyed by Run.key; a plain object because it crosses JSON */
  jobs: Record<string, Job[]>
  diagnostics: ProviderDiagnostic[]
  budget?: Budget
}

export type PaneMessage =
  | { type: "hello"; version: string; pid: number }
  | { type: "watch"; subscription: Subscription }
  | { type: "refresh"; repositories?: string[] }
  | { type: "older"; id: string; repositories: string[]; before: string; limit: number }

export type PollerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "budget"; budget: Budget }
  | { type: "older-result"; id: string; runs: Run[]; diagnostics: ProviderDiagnostic[] }

export const MIN_INTERVAL_MS = 5_000
export const IDLE_INTERVAL_MS = 15_000

const PANE_TYPES: ReadonlySet<string> = new Set(["hello", "watch", "refresh", "older"])
const POLLER_TYPES: ReadonlySet<string> = new Set(["snapshot", "budget", "older-result"])

/** One JSON line terminated by "\n" (JSON.stringify never emits a raw newline). */
export function encode(message: PaneMessage | PollerMessage): string {
  return `${JSON.stringify(message)}\n`
}

function hasType(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  )
}

/** Splits a buffer on "\n", returning parsed messages (unparseable lines reported) and the unconsumed tail. */
export function decodeLines(buffer: string): { messages: unknown[]; bad: string[]; rest: string } {
  const lines = buffer.split("\n")
  const rest = lines.pop() ?? ""
  const messages: unknown[] = []
  const bad: string[] = []
  for (const line of lines) {
    if (line === "") continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (hasType(parsed)) messages.push(parsed)
      else bad.push(line)
    } catch {
      bad.push(line)
    }
  }
  return { messages, bad, rest }
}

export function isPaneMessage(value: unknown): value is PaneMessage {
  return hasType(value) && PANE_TYPES.has(value.type)
}

export function isPollerMessage(value: unknown): value is PollerMessage {
  return hasType(value) && POLLER_TYPES.has(value.type)
}

/** Computes the socket path only; the caller creates the directory. */
export function socketPath(opts: {
  env: Record<string, string | undefined>
  version: string
  entryScript: string
  home: string
}): string {
  const override = opts.env.OPS_HUD_POLLER_SOCKET
  if (override) return override
  const cache = opts.env.XDG_CACHE_HOME || join(opts.home, ".cache")
  const dev = opts.entryScript.endsWith(".ts") ? "-dev" : ""
  return join(cache, "ops-hud", `poller-${opts.version}${dev}.sock`)
}

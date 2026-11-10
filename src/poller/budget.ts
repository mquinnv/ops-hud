import type { Budget } from "./protocol.js"

export const LOW_FRACTION = 0.1
export const LOW_FLOOR = 300
export const STRETCH_FACTOR = 4
export const DEFAULT_PAUSE_MS = 60_000

function num(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === "") return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export class RateBudget {
  private limit = 0
  private remaining = 0
  private resetAt = 0
  private pausedUntil = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Any response: reads x-ratelimit-limit/-remaining/-reset (epoch seconds). Missing headers leave the previous values. */
  record(headers: Headers): void {
    const limit = num(headers, "x-ratelimit-limit")
    const remaining = num(headers, "x-ratelimit-remaining")
    const reset = num(headers, "x-ratelimit-reset")
    if (limit !== undefined) this.limit = limit
    if (remaining !== undefined) this.remaining = remaining
    if (reset !== undefined) this.resetAt = reset * 1000
  }

  /** A 403/429 that is a rate limit: pause until retry-after, else reset when remaining is 0, else a default. */
  recordLimitHit(headers: Headers): void {
    this.record(headers)
    const now = this.now()
    const retryAfter = num(headers, "retry-after")
    let until: number
    if (retryAfter !== undefined) until = now + retryAfter * 1000
    else if (num(headers, "x-ratelimit-remaining") === 0) until = this.resetAt
    else until = now + DEFAULT_PAUSE_MS
    if (until > now) this.pausedUntil = until
  }

  get paused(): boolean {
    return this.pausedUntil > this.now()
  }

  get stretched(): boolean {
    if (this.limit <= 0) return false
    return this.remaining < Math.max(LOW_FLOOR, LOW_FRACTION * this.limit)
  }

  /** STRETCH_FACTOR when stretched, else 1 (paused is handled by the scheduler). */
  multiplier(): number {
    return this.stretched ? STRETCH_FACTOR : 1
  }

  snapshot(): Budget {
    const budget: Budget = {
      provider: "github",
      limit: this.limit,
      remaining: this.remaining,
      resetAt: this.resetAt,
      stretched: this.stretched,
    }
    if (this.paused) budget.pausedUntil = this.pausedUntil
    return budget
  }
}

/** True for a 429, or a 403 whose body or headers say rate limit. */
export function isRateLimitResponse(status: number, headers: Headers, bodyText: string): boolean {
  if (status === 429) return true
  if (status !== 403) return false
  return /rate limit/i.test(bodyText) || headers.get("x-ratelimit-remaining") === "0"
}

import { expect, test } from "bun:test"
import { isRateLimitResponse, RateBudget } from "./budget.js"

const h = (o: Record<string, string>) => new Headers(o)
const mk = (t = 1_000_000) => {
  const clock = { t }
  return { clock, b: new RateBudget(() => clock.t) }
}
const rl = (limit: number, remaining: number, reset = 2000) =>
  h({
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(reset),
  })

test("record reads the three headers", () => {
  const { b } = mk()
  b.record(rl(5000, 4489, 2000))
  const s = b.snapshot()
  expect(s.provider).toBe("github")
  expect(s.limit).toBe(5000)
  expect(s.remaining).toBe(4489)
  expect(s.resetAt).toBe(2_000_000)
  expect(s.stretched).toBe(false)
})

test("missing headers leave the previous values", () => {
  const { b } = mk()
  b.record(rl(5000, 4000))
  b.record(h({}))
  expect(b.snapshot().remaining).toBe(4000)
})

test("unknown budget is neither stretched nor paused", () => {
  const { b } = mk()
  expect(b.stretched).toBe(false)
  expect(b.paused).toBe(false)
  expect(b.multiplier()).toBe(1)
  const s = b.snapshot()
  expect(s).toEqual({ provider: "github", limit: 0, remaining: 0, resetAt: 0, stretched: false })
  expect("pausedUntil" in s).toBe(false)
})

test("stretched below 10% of the limit, and below 300 regardless of limit", () => {
  const { b } = mk()
  b.record(rl(5000, 499))
  expect(b.stretched).toBe(true)
  expect(b.multiplier()).toBe(4)
  b.record(rl(1000, 299))
  expect(b.stretched).toBe(true)
  b.record(rl(1000, 301))
  expect(b.stretched).toBe(false)
  expect(b.multiplier()).toBe(1)
})

test("a 429 with retry-after pauses for that many seconds", () => {
  const { b, clock } = mk()
  b.recordLimitHit(h({ "retry-after": "30" }))
  expect(b.paused).toBe(true)
  expect(b.snapshot().pausedUntil).toBe(1_030_000)
  clock.t = 1_030_000
  expect(b.paused).toBe(false)
  expect(b.snapshot().pausedUntil).toBeUndefined()
})

test("a 403 with remaining 0 pauses until reset", () => {
  const { b } = mk()
  b.recordLimitHit(rl(5000, 0, 1100))
  expect(b.snapshot().pausedUntil).toBe(1_100_000)
})

test("a hit with neither pauses for 60s", () => {
  const { b } = mk()
  b.recordLimitHit(h({}))
  expect(b.snapshot().pausedUntil).toBe(1_060_000)
})

test("a reset in the past does not pause", () => {
  const { b } = mk()
  b.recordLimitHit(rl(5000, 0, 500))
  expect(b.paused).toBe(false)
})

test("retry-after 0 does not pause", () => {
  const { b } = mk()
  b.recordLimitHit(h({ "retry-after": "0" }))
  expect(b.paused).toBe(false)
})

test("isRateLimitResponse", () => {
  expect(isRateLimitResponse(429, h({}), "")).toBe(true)
  expect(isRateLimitResponse(403, h({}), "API rate limit exceeded for user")).toBe(true)
  expect(isRateLimitResponse(403, h({}), "Resource not accessible by integration")).toBe(false)
  expect(isRateLimitResponse(403, h({ "x-ratelimit-remaining": "0" }), "")).toBe(true)
  expect(isRateLimitResponse(500, h({}), "rate limit")).toBe(false)
})

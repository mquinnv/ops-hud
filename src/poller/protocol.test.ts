import { describe, expect, test } from "bun:test"
import {
  decodeLines,
  encode,
  isPaneMessage,
  isPollerMessage,
  type PaneMessage,
  type PollerMessage,
  socketPath,
} from "./protocol.js"

const hello: PaneMessage = { type: "hello", version: "2.1.0", pid: 42 }
const budget: PollerMessage = {
  type: "budget",
  budget: { provider: "github", limit: 5000, remaining: 10, resetAt: 1, stretched: false },
}

describe("framing", () => {
  test("encode produces one line per message", () => {
    const line = encode({ type: "older", id: "a\nb", repositories: ["x/y"], before: "t", limit: 5 })
    expect(line.endsWith("\n")).toBe(true)
    expect(line.slice(0, -1)).not.toContain("\n")
    expect(JSON.parse(line)).toMatchObject({ type: "older", id: "a\nb" })
  })

  test("decodeLines returns complete messages and keeps the partial tail", () => {
    const out = decodeLines('{"type":"refresh"}\n{"type":"he')
    expect(out.messages).toEqual([{ type: "refresh" }])
    expect(out.bad).toEqual([])
    expect(out.rest).toBe('{"type":"he')
  })

  test("decodeLines reports a line that is not JSON, and one with no type, as bad", () => {
    const out = decodeLines('nope\n{"x":1}\n[1]\n\n{"type":"refresh"}\n')
    expect(out.messages).toEqual([{ type: "refresh" }])
    expect(out.bad).toEqual(["nope", '{"x":1}', "[1]"])
    expect(out.rest).toBe("")
  })

  test("encode and decodeLines round-trip", () => {
    expect(decodeLines(encode(hello) + encode(budget)).messages).toEqual([hello, budget])
  })
})

describe("type guards", () => {
  test("isPaneMessage rejects a poller message and vice versa", () => {
    expect(isPaneMessage(hello)).toBe(true)
    expect(isPaneMessage(budget)).toBe(false)
    expect(isPollerMessage(budget)).toBe(true)
    expect(isPollerMessage(hello)).toBe(false)
    expect(isPaneMessage(null)).toBe(false)
    expect(isPaneMessage("hello")).toBe(false)
    expect(isPollerMessage({})).toBe(false)
  })
})

describe("socketPath", () => {
  const base = { version: "2.1.0", entryScript: "dist/index.js", home: "/home/u" }

  test("honors OPS_HUD_POLLER_SOCKET outright", () => {
    expect(socketPath({ ...base, env: { OPS_HUD_POLLER_SOCKET: "/tmp/x.sock" } })).toBe(
      "/tmp/x.sock",
    )
  })

  test("uses XDG_CACHE_HOME when set, else ~/.cache", () => {
    expect(socketPath({ ...base, env: { XDG_CACHE_HOME: "/xdg" } })).toBe(
      "/xdg/ops-hud/poller-2.1.0.sock",
    )
    expect(socketPath({ ...base, env: {} })).toBe("/home/u/.cache/ops-hud/poller-2.1.0.sock")
  })

  test("adds -dev when the entry script is a .ts file", () => {
    expect(socketPath({ ...base, entryScript: "src/index.ts", env: {} })).toBe(
      "/home/u/.cache/ops-hud/poller-2.1.0-dev.sock",
    )
  })
})

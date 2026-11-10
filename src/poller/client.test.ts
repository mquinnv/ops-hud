import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchResult } from "../providers/types.js"
import { RateBudget } from "./budget.js"
import {
  InProcessPollerClient,
  type PollerStatus,
  type SocketClientOptions,
  SocketPollerClient,
} from "./client.js"
import { type GitHubSource, PollerCore } from "./core.js"
import type { RepoState } from "./github-poller.js"
import type { Budget, Snapshot, Subscription } from "./protocol.js"
import { PollerServer } from "./server.js"

const VERSION = "9.9.9"
const REPO = "acme/app"

class FakeGitHubPoller implements GitHubSource {
  readonly budget = new RateBudget()

  async poll(_repo: string): Promise<{ changed: boolean }> {
    return { changed: true }
  }

  state(_repo: string): RepoState | undefined {
    return undefined
  }

  isActive(_repo: string): boolean {
    return false
  }

  forget(_repo: string): void {}

  async fetchOlder(repositories: string[], before: string, limit: number): Promise<FetchResult> {
    return {
      runs: [],
      diagnostics: [
        { provider: "github", level: "info", message: `${repositories[0]} ${before} ${limit}` },
      ],
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await sleep(5)
  }
}

const subscription = (): Subscription => ({ repositories: [REPO], interval: 5_000, github: true })

/** A core whose stop() calls are counted. */
function makeCore(): PollerCore & { stops: number } {
  const core = new PollerCore({
    github: new FakeGitHubPoller(),
    buildkiteFactory: () => ({}) as never,
  }) as PollerCore & { stops: number }
  core.stops = 0
  const stop = core.stop.bind(core)
  core.stop = () => {
    core.stops++
    stop()
  }
  return core
}

let dir: string
let path: string
let servers: PollerServer[]
let cores: PollerCore[]
let closers: (() => void)[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohc-"))
  path = join(dir, "s", "p.sock")
  servers = []
  cores = []
  closers = []
})

afterEach(async () => {
  for (const close of closers) close()
  for (const s of servers) await s.close()
  for (const core of cores) core.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** A real PollerServer at `path` over its own core. */
function pollerServer(): { server: PollerServer; core: PollerCore & { stops: number } } {
  const core = makeCore()
  cores.push(core)
  const server = new PollerServer(core, { socketPath: path, version: VERSION })
  servers.push(server)
  return { server, core }
}

interface Harness {
  client: SocketPollerClient
  snapshots: Snapshot[]
  budgets: Budget[]
  statuses: PollerStatus[]
  spawns: number
  fallbackCores: (PollerCore & { stops: number })[]
}

function harness(opts: Partial<SocketClientOptions> & { onSpawn?: () => void } = {}): Harness {
  const h = { snapshots: [], budgets: [], statuses: [], spawns: 0, fallbackCores: [] } as Omit<
    Harness,
    "client"
  >
  const client = new SocketPollerClient({
    socketPath: path,
    version: VERSION,
    spawnPoller: () => {
      h.spawns++
      opts.onSpawn?.()
    },
    makeFallbackCore: () => {
      const core = makeCore()
      cores.push(core)
      h.fallbackCores.push(core)
      return core
    },
    startupTimeoutMs: 200,
    retryMs: 20,
    rejoinMs: 50,
    ...opts,
  })
  client.onSnapshot((s) => h.snapshots.push(s))
  client.onBudget((b) => h.budgets.push(b))
  client.onStatus((s) => h.statuses.push(s))
  closers.push(() => client.close())
  return Object.assign(h, { client }) as Harness
}

test("connects to a running poller and forwards watch after hello", async () => {
  const { server, core } = pollerServer()
  await server.listen()
  const h = harness()
  // Remembered before the connection exists; a watch ahead of hello would be refused.
  h.client.watch(subscription())
  await h.client.start()
  await waitFor(() => h.snapshots.length > 0)
  expect(h.snapshots[0].repositories).toEqual([REPO])
  await waitFor(() => h.budgets.length > 0)
  expect(core.clientCount).toBe(1)
  expect(h.spawns).toBe(0)
  expect(h.statuses.at(-1)?.mode).toBe("shared")
  expect(h.fallbackCores).toEqual([])
})

test("with no poller it spawns one, retries, and connects when it appears", async () => {
  const { server, core } = pollerServer()
  const h = harness({
    startupTimeoutMs: 1_000,
    onSpawn: () => setTimeout(() => void server.listen(), 150),
  })
  h.client.watch(subscription())
  await h.client.start()
  expect(h.spawns).toBe(1)
  expect(h.statuses.at(-1)?.mode).toBe("shared")
  await waitFor(() => h.snapshots.length > 0)
  expect(core.clientCount).toBe(1)
  expect(h.fallbackCores).toEqual([])
})

test("a stale socket file older than 5s is unlinked before spawning; a fresh one is not", async () => {
  const NOW = 1_000_000
  const run = async (mtime: number) => {
    const unlinked: string[] = []
    const order: string[] = []
    const h = harness({
      now: () => NOW,
      mtimeOf: () => mtime,
      unlink: (p) => {
        unlinked.push(p)
        order.push("unlink")
      },
      onSpawn: () => order.push("spawn"),
      startupTimeoutMs: 60,
    })
    await h.client.start()
    h.client.close()
    return { unlinked, order, spawns: h.spawns }
  }

  const stale = await run(NOW - 6_000)
  expect(stale.unlinked).toEqual([path])
  expect(stale.order).toEqual(["unlink", "spawn"])

  const fresh = await run(NOW - 1_000)
  expect(fresh.unlinked).toEqual([])
  expect(fresh.spawns).toBe(1)
})

test("falls back in-process after the startup timeout and reports mode in-process", async () => {
  const h = harness()
  h.client.watch(subscription())
  const started = Date.now()
  await h.client.start()
  expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  expect(h.spawns).toBe(1)
  expect(h.statuses.at(-1)?.mode).toBe("in-process")
  expect(h.fallbackCores).toHaveLength(1)
  expect(h.snapshots[0]?.repositories).toEqual([REPO])
  const older = await h.client.older([REPO], "2024-01-01T00:00:00Z", 3)
  expect(older.diagnostics[0].message).toBe(`${REPO} 2024-01-01T00:00:00Z 3`)
})

test("an in-process client rejoins when the socket appears later", async () => {
  const h = harness()
  h.client.watch(subscription())
  await h.client.start()
  expect(h.statuses.at(-1)?.mode).toBe("in-process")
  const fallback = h.fallbackCores[0]
  const before = h.snapshots.length

  const { server, core } = pollerServer()
  await server.listen()
  await waitFor(() => h.statuses.at(-1)?.mode === "shared")
  expect(fallback.stops).toBeGreaterThan(0)
  expect(fallback.clientCount).toBe(0)
  // watch was re-sent to the poller.
  await waitFor(() => core.clientCount === 1)
  await waitFor(() => h.snapshots.length > before)
  expect(h.spawns).toBe(1)
})

test("EACCES on connect goes straight to in-process without a spawn loop", async () => {
  let connects = 0
  const h = harness({
    startupTimeoutMs: 5_000,
    rejoinMs: 10_000,
    connect: () => {
      connects++
      const socket = new Socket()
      setImmediate(() =>
        socket.emit("error", Object.assign(new Error("connect EACCES"), { code: "EACCES" })),
      )
      return socket
    },
  })
  const started = Date.now()
  await h.client.start()
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(h.spawns).toBe(0)
  expect(connects).toBe(1)
  expect(h.statuses.at(-1)?.mode).toBe("in-process")
  expect(h.fallbackCores).toHaveLength(1)
})

test("a dropped connection is retried and the client reconnects", async () => {
  const first = pollerServer()
  await first.server.listen()
  let second: ReturnType<typeof pollerServer> | undefined
  const h = harness({
    startupTimeoutMs: 1_000,
    onSpawn: () => {
      second = pollerServer()
      void second.server.listen()
    },
  })
  h.client.watch(subscription())
  await h.client.start()
  await waitFor(() => h.snapshots.length > 0)
  const shared = h.statuses.length
  const before = h.snapshots.length

  await first.server.close()
  await waitFor(() => second !== undefined && second.core.clientCount === 1)
  expect(h.spawns).toBe(1)
  expect(h.statuses.slice(shared).some((s) => s.message.includes("reconnecting"))).toBe(true)
  expect(h.statuses.at(-1)?.mode).toBe("shared")
  expect(h.fallbackCores).toEqual([])
  await waitFor(() => h.snapshots.length > before)
})

test("older resolves with the matching older-result", async () => {
  const { server } = pollerServer()
  await server.listen()
  const h = harness()
  // Queued until the connection is up.
  const early = h.client.older([REPO], "2024-01-01T00:00:00Z", 5)
  await h.client.start()
  const [a, b] = await Promise.all([
    h.client.older(["x/a"], "2024-02-02T00:00:00Z", 1),
    h.client.older(["x/b"], "2024-03-03T00:00:00Z", 2),
  ])
  expect((await early).diagnostics[0].message).toBe(`${REPO} 2024-01-01T00:00:00Z 5`)
  expect(a.diagnostics[0].message).toBe("x/a 2024-02-02T00:00:00Z 1")
  expect(b.diagnostics[0].message).toBe("x/b 2024-03-03T00:00:00Z 2")
})

test("InProcessPollerClient delivers snapshots from the core", async () => {
  const core = makeCore()
  cores.push(core)
  const client = new InProcessPollerClient(core)
  closers.push(() => client.close())
  const snapshots: Snapshot[] = []
  const budgets: Budget[] = []
  const statuses: PollerStatus[] = []
  client.onSnapshot((s) => snapshots.push(s))
  client.onBudget((b) => budgets.push(b))
  client.onStatus((s) => statuses.push(s))
  client.watch(subscription())
  expect(snapshots[0]?.repositories).toEqual([REPO])
  expect(budgets).toHaveLength(1)
  expect(core.clientCount).toBe(1)
  await waitFor(() => statuses.length > 0)
  expect(statuses[0].mode).toBe("in-process")
  client.close()
  client.close()
  expect(core.clientCount).toBe(0)
  expect(core.stops).toBeGreaterThan(0)
})

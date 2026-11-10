import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchResult } from "../providers/types.js"
import { RateBudget } from "./budget.js"
import { type GitHubSource, PollerCore } from "./core.js"
import type { RepoState } from "./github-poller.js"
import { decodeLines, encode, type PaneMessage, type Subscription } from "./protocol.js"
import { PollerServer, type ServerOptions } from "./server.js"

const VERSION = "9.9.9"
const REPO = "acme/app"

class FakeGitHubPoller implements GitHubSource {
  readonly budget = new RateBudget()
  readonly polls: string[] = []

  async poll(repo: string): Promise<{ changed: boolean }> {
    this.polls.push(repo)
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

interface Client {
  socket: Socket
  send(message: PaneMessage | string): void
  /** The next message of this type; others (e.g. budget broadcasts) are skipped. */
  next(type?: string): Promise<Record<string, unknown>>
  closed: Promise<void>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await sleep(5)
  }
}

let dir: string
let path: string
let github: FakeGitHubPoller
let core: PollerCore
let logs: string[]
let idles: number
let servers: PollerServer[]
let clients: Client[]

async function connect(socketPath = path): Promise<Client> {
  const socket = createConnection(socketPath)
  socket.setEncoding("utf8")
  const queue: Record<string, unknown>[] = []
  const waiters: { type: string; resolve: (message: Record<string, unknown>) => void }[] = []
  let buffer = ""
  socket.on("data", (data: string) => {
    const { messages, rest } = decodeLines(buffer + data)
    buffer = rest
    for (const message of messages as Record<string, unknown>[]) {
      const index = waiters.findIndex((w) => w.type === message.type)
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
      else queue.push(message)
    }
  })
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()))
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.on("error", () => {})
  const client: Client = {
    socket,
    send: (message) => socket.write(typeof message === "string" ? message : encode(message)),
    next: (type = "snapshot") => {
      const index = queue.findIndex((m) => m.type === type)
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0])
      return new Promise((resolve) => waiters.push({ type, resolve }))
    },
    closed,
  }
  clients.push(client)
  return client
}

function server(opts: Partial<ServerOptions> = {}): PollerServer {
  const s = new PollerServer(core, {
    socketPath: path,
    version: VERSION,
    log: (line) => logs.push(line),
    onIdle: () => idles++,
    ...opts,
  })
  servers.push(s)
  return s
}

const subscription = (repositories = [REPO]): Subscription => ({
  repositories,
  interval: 5_000,
  github: true,
})

async function watcher(): Promise<Client> {
  const client = await connect()
  client.send({ type: "hello", version: VERSION, pid: 1 })
  client.send({ type: "watch", subscription: subscription() })
  return client
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohp-"))
  path = join(dir, "s", "p.sock")
  github = new FakeGitHubPoller()
  core = new PollerCore({ github, buildkiteFactory: () => ({}) as never })
  logs = []
  idles = 0
  servers = []
  clients = []
})

afterEach(async () => {
  for (const client of clients) client.socket.destroy()
  for (const s of servers) await s.close()
  core.stop()
  rmSync(dir, { recursive: true, force: true })
})

test("hello with a matching version is accepted; a mismatch closes the connection", async () => {
  await server().listen()
  const good = await watcher()
  expect((await good.next()).type).toBe("snapshot")

  const bad = await connect()
  bad.send({ type: "hello", version: "0.0.1", pid: 2 })
  await bad.closed
  expect(good.socket.destroyed).toBe(false)
  expect(core.clientCount).toBe(1)
})

test("watch subscribes and the client receives a snapshot line", async () => {
  await server().listen()
  const client = await watcher()
  const message = await client.next()
  expect(message.type).toBe("snapshot")
  expect((await client.next("budget")).budget).toMatchObject({ provider: "github" })
  expect((message.snapshot as { repositories: string[] }).repositories).toEqual([REPO])
  expect(core.clientCount).toBe(1)
})

test("two clients watching one repo cause one core subscription per client and one github poll", async () => {
  await server().listen()
  const a = await watcher()
  const b = await watcher()
  await a.next()
  await b.next()
  expect(core.clientCount).toBe(2)
  await core.tick()
  expect(github.polls.filter((r) => r === REPO)).toEqual([REPO])
})

test("a client disconnect unsubscribes it", async () => {
  await server().listen()
  const a = await watcher()
  const b = await watcher()
  await a.next()
  await b.next()
  expect(core.clientCount).toBe(2)
  a.socket.end()
  await waitFor(() => core.clientCount === 1)
})

test("the server calls onIdle lingerMs after the last client leaves, not before", async () => {
  await server({ lingerMs: 50 }).listen()
  const client = await watcher()
  await client.next()
  client.socket.end()
  await waitFor(() => core.clientCount === 0)
  await sleep(20)
  expect(idles).toBe(0)
  await waitFor(() => idles === 1)
  expect(existsSync(path)).toBe(false)
})

test("a new client during the linger cancels it", async () => {
  await server({ lingerMs: 50 }).listen()
  const first = await watcher()
  await first.next()
  first.socket.end()
  await waitFor(() => core.clientCount === 0)
  const second = await watcher()
  await second.next()
  await sleep(120)
  expect(idles).toBe(0)
  expect(core.clientCount).toBe(1)
})

test("a garbage line is logged and ignored; the next valid line still works", async () => {
  await server().listen()
  const client = await connect()
  client.send("this is not json\n")
  client.send({ type: "hello", version: VERSION, pid: 1 })
  client.send('{"type":"bogus"}\n')
  client.send({ type: "watch", subscription: subscription() })
  expect((await client.next()).type).toBe("snapshot")
  expect(logs.some((line) => line.includes("this is not json"))).toBe(true)
  expect(logs.some((line) => line.includes("bogus"))).toBe(true)
})

test("a client that sends over 1 MiB without a newline is disconnected", async () => {
  await server().listen()
  const client = await connect()
  client.send({ type: "hello", version: VERSION, pid: 1 })
  client.send("x".repeat(1024 * 1024 + 10))
  await client.closed
  expect(logs.some((line) => line.includes("1 MiB"))).toBe(true)
  const other = await watcher()
  expect((await other.next()).type).toBe("snapshot")
})

test("listen() rejects with EADDRINUSE when another server holds the path", async () => {
  await server().listen()
  const second = server()
  await expect(second.listen()).rejects.toMatchObject({ code: "EADDRINUSE" })
  // The loser's close() must not remove the winner's socket.
  await second.close()
  expect(existsSync(path)).toBe(true)
  const client = await watcher()
  expect((await client.next()).type).toBe("snapshot")
})

test("close() removes the socket file", async () => {
  const s = server()
  await s.listen()
  expect(existsSync(path)).toBe(true)
  await watcher()
  await s.close()
  expect(existsSync(path)).toBe(false)
})

test("the server stops when its socket file disappears", async () => {
  await server({ socketCheckMs: 20 }).listen()
  unlinkSync(path)
  await waitFor(() => idles === 1)
})

test("older is answered with an older-result carrying the same id", async () => {
  await server().listen()
  const client = await watcher()
  await client.next()
  client.send({
    type: "older",
    id: "q7",
    repositories: [REPO],
    before: "2024-01-01T00:00:00Z",
    limit: 5,
  })
  expect(await client.next("older-result")).toEqual({
    type: "older-result",
    id: "q7",
    runs: [],
    diagnostics: [{ provider: "github", level: "info", message: `${REPO} 2024-01-01T00:00:00Z 5` }],
  })
})

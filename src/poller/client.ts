import { spawn } from "node:child_process"
import { statSync, unlinkSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { homedir } from "node:os"
import { execa } from "execa"
import { BuildkiteProvider } from "../providers/buildkite.js"
import type { FetchResult } from "../providers/types.js"
import { PollerCore } from "./core.js"
import { GitHubPoller, resolveGitHubToken } from "./github-poller.js"
import {
  type Budget,
  decodeLines,
  encode,
  isPollerMessage,
  type PaneMessage,
  type PollerMessage,
  type Snapshot,
  type Subscription,
  socketPath,
} from "./protocol.js"

export interface PollerStatus {
  mode: "shared" | "in-process"
  pid?: number
  message: string
}

export interface PollerClient {
  /** Runs any startup the client needs; Task 9 awaits it when present. Never rejects. */
  start?(): Promise<void>
  watch(subscription: Subscription): void
  refresh(repositories?: string[]): void
  older(repositories: string[], before: string, limit: number): Promise<FetchResult>
  onSnapshot(cb: (snapshot: Snapshot) => void): void
  onBudget(cb: (budget: Budget) => void): void
  onStatus(cb: (status: PollerStatus) => void): void
  close(): void
}

export const STARTUP_TIMEOUT_MS = 3_000
export const RETRY_MS = 100
export const REJOIN_MS = 30_000
export const STALE_SOCKET_MS = 5_000
/** Larger than the server's 1 MiB: an org-wide snapshot can legitimately pass 1 MiB. */
export const MAX_INBOUND_BYTES = 16 * 1024 * 1024

const LOCAL_CLIENT_ID = "local"
const disconnected = (): FetchResult => ({
  runs: [],
  diagnostics: [{ provider: "github", level: "error", message: "poller disconnected" }],
})

/** Listener fan-out; a throwing listener must not break the socket or the core. */
class Listeners<T> {
  private readonly cbs: ((value: T) => void)[] = []
  add(cb: (value: T) => void): void {
    this.cbs.push(cb)
  }
  emit(value: T): void {
    for (const cb of this.cbs) {
      try {
        cb(value)
      } catch {}
    }
  }
}

/** Runs a PollerCore inside this process, subscribed as the single client "local". */
export class InProcessPollerClient implements PollerClient {
  private readonly snapshots = new Listeners<Snapshot>()
  private readonly budgets = new Listeners<Budget>()
  private started = false
  private closed = false

  constructor(private readonly core: PollerCore) {
    core.onSnapshot((clientId, snapshot) => {
      if (clientId === LOCAL_CLIENT_ID && !this.closed) this.snapshots.emit(snapshot)
    })
    core.onBudget((budget) => {
      if (!this.closed) this.budgets.emit(budget)
    })
  }

  watch(subscription: Subscription): void {
    if (this.closed) return
    this.core.subscribe(LOCAL_CLIENT_ID, subscription)
    if (!this.started) {
      this.started = true
      this.core.start()
    }
  }

  refresh(repositories?: string[]): void {
    if (!this.closed) void this.core.refresh(LOCAL_CLIENT_ID, repositories)
  }

  older(repositories: string[], before: string, limit: number): Promise<FetchResult> {
    return this.core.older(repositories, before, limit)
  }

  onSnapshot(cb: (snapshot: Snapshot) => void): void {
    this.snapshots.add(cb)
  }

  onBudget(cb: (budget: Budget) => void): void {
    this.budgets.add(cb)
  }

  onStatus(cb: (status: PollerStatus) => void): void {
    queueMicrotask(() => cb({ mode: "in-process", message: "polling in this process" }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.core.unsubscribe(LOCAL_CLIENT_ID)
    this.core.stop()
  }
}

export interface SocketClientOptions {
  socketPath: string
  version: string
  spawnPoller: () => void
  makeFallbackCore: () => PollerCore
  connect?: (path: string) => Socket
  now?: () => number
  startupTimeoutMs?: number
  retryMs?: number
  rejoinMs?: number
  staleSocketMs?: number
  /** mtime lookup, injectable; default fs.statSync */
  mtimeOf?: (path: string) => number | undefined
  unlink?: (path: string) => void
  /** Default process.platform. On win32 there is no Unix socket: the client polls in-process. */
  platform?: string
}

type Queued =
  | { type: "refresh"; repositories?: string[] }
  | {
      type: "older"
      repositories: string[]
      before: string
      limit: number
      resolve: (result: FetchResult) => void
    }

type Attempt = { socket: Socket } | { code: string }

const RETRYABLE: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOENT"])

function defaultMtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function defaultUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/**
 * Talks to the machine's shared poller over its socket, spawning it when absent.
 * When it cannot be reached it runs a PollerCore in-process and keeps trying to rejoin.
 */
export class SocketPollerClient implements PollerClient {
  private readonly connect: (path: string) => Socket
  private readonly now: () => number
  private readonly startupTimeoutMs: number
  private readonly retryMs: number
  private readonly rejoinMs: number
  private readonly staleSocketMs: number
  private readonly mtimeOf: (path: string) => number | undefined
  private readonly unlink: (path: string) => void
  private readonly platform: string
  private readonly snapshots = new Listeners<Snapshot>()
  private readonly budgets = new Listeners<Budget>()
  private readonly statuses = new Listeners<PollerStatus>()
  private subscription?: Subscription
  /** refresh/older calls made while neither a socket nor a fallback is up. */
  private queue: Queued[] = []
  /** older requests sent on the current socket, by id. */
  private readonly inFlight = new Map<string, (result: FetchResult) => void>()
  private nextId = 0
  private socket?: Socket
  private fallback?: InProcessPollerClient
  private starting?: Promise<void>
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly wakers = new Set<() => void>()
  private closed = false

  constructor(private readonly opts: SocketClientOptions) {
    this.connect = opts.connect ?? ((path) => createConnection(path))
    this.now = opts.now ?? Date.now
    this.startupTimeoutMs = opts.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
    this.retryMs = opts.retryMs ?? RETRY_MS
    this.rejoinMs = opts.rejoinMs ?? REJOIN_MS
    this.staleSocketMs = opts.staleSocketMs ?? STALE_SOCKET_MS
    this.mtimeOf = opts.mtimeOf ?? defaultMtimeOf
    this.unlink = opts.unlink ?? defaultUnlink
    this.platform = opts.platform ?? process.platform
  }

  /** Runs the startup procedure; resolves once connected or once the fallback is in place. Never rejects. */
  start(): Promise<void> {
    this.starting ??= this.platform === "win32" ? this.startInProcess() : this.startup()
    return this.starting
  }

  watch(subscription: Subscription): void {
    this.subscription = subscription
    if (this.socket) this.send({ type: "watch", subscription })
    // A fallback still running while a rejoined socket proves itself keeps
    // the subscription too, in case that socket is refused.
    this.fallback?.watch(subscription)
  }

  refresh(repositories?: string[]): void {
    this.dispatch({ type: "refresh", repositories })
  }

  older(repositories: string[], before: string, limit: number): Promise<FetchResult> {
    if (this.closed) return Promise.resolve(disconnected())
    return new Promise((resolve) =>
      this.dispatch({ type: "older", repositories, before, limit, resolve }),
    )
  }

  onSnapshot(cb: (snapshot: Snapshot) => void): void {
    this.snapshots.add(cb)
  }

  onBudget(cb: (budget: Budget) => void): void {
    this.budgets.add(cb)
  }

  onStatus(cb: (status: PollerStatus) => void): void {
    this.statuses.add(cb)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const wake of this.wakers) wake()
    this.socket?.destroy()
    this.socket = undefined
    this.fallback?.close()
    this.fallback = undefined
    this.abandonOlder()
    for (const item of this.queue) if (item.type === "older") item.resolve(disconnected())
    this.queue = []
  }

  /** Steps 1-4 of the spec: reach the poller, else fall back. */
  private async startup(): Promise<void> {
    const socket = await this.establish()
    if (this.closed) socket?.destroy()
    else if (socket) this.attach(socket)
    else this.fallBack()
  }

  /** win32: no Unix socket to share, so poll here from the start and never rejoin. */
  private async startInProcess(): Promise<void> {
    if (!this.closed) this.fallBack()
  }

  /**
   * Steps 1-3 of the spec: connect, else stale check + spawn once, retry
   * until the timeout. The socket, or undefined when the poller stayed out of reach.
   */
  private async establish(): Promise<Socket | undefined> {
    let timedOut = false
    this.later(this.startupTimeoutMs, () => {
      timedOut = true
    })
    let spawned = false
    while (!this.closed) {
      const attempt = await this.attempt()
      if (this.closed) break
      if ("socket" in attempt) return attempt.socket
      if (!RETRYABLE.has(attempt.code) || timedOut) break
      if (!spawned) {
        spawned = true
        if (!this.spawn()) break
      }
      await this.sleep(this.retryMs)
      if (timedOut) break
    }
    return undefined
  }

  /** Removes a stale socket file and spawns the poller; false when that cannot be done safely. */
  private spawn(): boolean {
    try {
      const mtime = this.mtimeOf(this.opts.socketPath)
      // A fresh file may belong to a poller that has only just bound it.
      if (mtime !== undefined && this.now() - mtime > this.staleSocketMs) {
        this.unlink(this.opts.socketPath)
      }
      this.opts.spawnPoller()
      return true
    } catch {
      return false
    }
  }

  private attempt(): Promise<Attempt> {
    return new Promise((resolve) => {
      let socket: Socket
      try {
        socket = this.connect(this.opts.socketPath)
      } catch (error) {
        resolve({ code: (error as NodeJS.ErrnoException).code ?? "EUNKNOWN" })
        return
      }
      const onConnect = () => {
        socket.off("error", onError)
        if (this.closed) socket.destroy()
        resolve({ socket })
      }
      const onError = (error: NodeJS.ErrnoException) => {
        socket.off("connect", onConnect)
        socket.destroy()
        resolve({ code: error.code ?? "EUNKNOWN" })
      }
      socket.once("connect", onConnect)
      socket.once("error", onError)
    })
  }

  /**
   * Makes `socket` the connection. A fallback that is running (a rejoin) is
   * kept until the poller's first message, so a poller that refuses this pane
   * at hello leaves it polling here without rebuilding its core.
   */
  private attach(socket: Socket): void {
    this.socket = socket
    const proving = this.fallback !== undefined
    let received = false
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (data: string) => {
      const { messages, rest } = decodeLines(buffer + data)
      buffer = rest
      for (const message of messages) {
        if (!received) {
          received = true
          if (this.socket === socket) this.retireFallback()
        }
        if (isPollerMessage(message)) this.receive(message)
      }
      if (buffer.length > MAX_INBOUND_BYTES) socket.destroy()
    })
    socket.on("error", () => {})
    socket.on("close", () => this.dropped(socket, received))
    this.send({ type: "hello", version: this.opts.version, pid: process.pid })
    if (this.subscription) this.send({ type: "watch", subscription: this.subscription })
    this.flush()
    if (!proving) this.statuses.emit({ mode: "shared", message: "connected to the shared poller" })
  }

  /** The shared poller has answered: the in-process core is no longer needed. */
  private retireFallback(): void {
    const fallback = this.fallback
    if (!fallback) return
    this.fallback = undefined
    fallback.close()
    this.statuses.emit({ mode: "shared", message: "connected to the shared poller" })
  }

  private receive(message: PollerMessage): void {
    switch (message.type) {
      case "snapshot":
        this.snapshots.emit(message.snapshot)
        return
      case "budget":
        this.budgets.emit(message.budget)
        return
      case "older-result": {
        const resolve = this.inFlight.get(message.id)
        this.inFlight.delete(message.id)
        resolve?.({ runs: message.runs, diagnostics: message.diagnostics })
        return
      }
    }
  }

  private dropped(socket: Socket, received: boolean): void {
    if (this.socket !== socket || this.closed) return
    this.socket = undefined
    this.abandonOlder()
    // A poller that hangs up before saying anything has most likely refused us
    // (e.g. a version mismatch); reconnecting at once would only loop. A
    // fallback still running from before this rejoin carries on as it was.
    if (!received) {
      if (this.fallback) this.scheduleRejoin()
      else this.fallBack()
      return
    }
    this.statuses.emit({ mode: "shared", message: "poller gone, reconnecting" })
    void this.startup()
  }

  /** Step 4: run the core here; step 5: keep trying the socket every rejoinMs. */
  private fallBack(): void {
    let core: PollerCore
    try {
      core = this.opts.makeFallbackCore()
    } catch (error) {
      // Nothing can poll: report it and go inert (close() answers later calls) rather than reject.
      const reason = error instanceof Error ? error.message : String(error)
      this.statuses.emit({ mode: "in-process", message: `poller unavailable: ${reason}` })
      this.close()
      return
    }
    const fallback = new InProcessPollerClient(core)
    // Silent while a rejoined socket is on probation: the socket speaks for the pane.
    fallback.onSnapshot((snapshot) => {
      if (!this.socket) this.snapshots.emit(snapshot)
    })
    fallback.onBudget((budget) => {
      if (!this.socket) this.budgets.emit(budget)
    })
    this.fallback = fallback
    this.statuses.emit({ mode: "in-process", message: "shared poller unavailable; polling here" })
    if (this.subscription) fallback.watch(this.subscription)
    this.flush()
    if (this.platform !== "win32") this.scheduleRejoin()
  }

  private scheduleRejoin(): void {
    this.later(this.rejoinMs, () => void this.rejoin())
  }

  /**
   * Step 5: the whole startup procedure again (connect, stale check and one
   * spawn, retry until the timeout), so a pane stranded in-process starts a
   * poller rather than waiting for another pane to. The fallback keeps running
   * throughout; never rejects, and reschedules itself until it succeeds.
   */
  private async rejoin(): Promise<void> {
    try {
      const socket = await this.establish()
      if (this.closed) socket?.destroy()
      else if (socket) this.attach(socket)
      else this.scheduleRejoin()
    } catch {
      if (!this.closed && !this.socket) this.scheduleRejoin()
    }
  }

  private dispatch(item: Queued): void {
    if (this.closed) return
    if (this.socket) this.sendQueued(item)
    else if (this.fallback) this.runLocally(this.fallback, item)
    else this.queue.push(item)
  }

  private flush(): void {
    const queue = this.queue
    this.queue = []
    for (const item of queue) this.dispatch(item)
  }

  private sendQueued(item: Queued): void {
    if (item.type === "refresh") {
      this.send({ type: "refresh", repositories: item.repositories })
      return
    }
    const id = `o${++this.nextId}`
    this.inFlight.set(id, item.resolve)
    const { repositories, before, limit } = item
    this.send({ type: "older", id, repositories, before, limit })
  }

  private runLocally(fallback: InProcessPollerClient, item: Queued): void {
    if (item.type === "refresh") fallback.refresh(item.repositories)
    else fallback.older(item.repositories, item.before, item.limit).then(item.resolve)
  }

  private send(message: PaneMessage): void {
    const socket = this.socket
    if (socket && !socket.destroyed && socket.writable) socket.write(encode(message))
  }

  private abandonOlder(): void {
    for (const resolve of this.inFlight.values()) resolve(disconnected())
    this.inFlight.clear()
  }

  /** An unref'ed timeout that close() clears. */
  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    timer.unref()
    this.timers.add(timer)
  }

  /** Resolves after ms, or at once when the client closes. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.wakers.delete(wake)
        resolve()
      }
      this.wakers.add(wake)
      this.later(ms, wake)
    })
  }
}

/** Production wiring: socketPath() from env/version/argv, spawnPoller = spawn(process.execPath, [process.argv[1], "__poller"], { detached: true, stdio: "ignore" }).unref(). */
export function createPollerClient(opts: { version: string }): SocketPollerClient {
  return new SocketPollerClient({
    version: opts.version,
    socketPath: socketPath({
      env: process.env,
      version: opts.version,
      entryScript: process.argv[1] ?? "",
      home: homedir(),
    }),
    spawnPoller: () => {
      const child = spawn(process.execPath, [process.argv[1] ?? "", "__poller"], {
        detached: true,
        stdio: "ignore",
      })
      // A spawn failure surfaces as an 'error' event; the startup timeout handles it.
      child.on("error", () => {})
      child.unref()
    },
    makeFallbackCore: () =>
      new PollerCore({
        github: new GitHubPoller({
          resolveToken: () => resolveGitHubToken(process.env, (file, args) => execa(file, args)),
        }),
        buildkiteFactory: (buildkite) => new BuildkiteProvider(buildkite),
      }),
  })
}

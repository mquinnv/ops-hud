import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { dirname } from "node:path"
import type { PollerCore } from "./core.js"
import {
  decodeLines,
  encode,
  isPaneMessage,
  type PaneMessage,
  type PollerMessage,
} from "./protocol.js"

export const LINGER_MS = 60_000
export const SOCKET_CHECK_MS = 60_000
/** A pane never sends a line anywhere near this long; past it the peer is broken or hostile. */
export const MAX_LINE_BYTES = 1024 * 1024
const END_GRACE_MS = 1_000

export interface ServerOptions {
  socketPath: string
  version: string
  lingerMs?: number
  socketCheckMs?: number
  log?: (line: string) => void
  /** Called instead of process.exit when the server decides to stop; tests observe it. */
  onIdle?: () => void
}

/** How a connect to the socket path went: "connected", or the error code. */
function probe(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once("connect", () => {
      socket.destroy()
      resolve("connected")
    })
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "EUNKNOWN"))
  })
}

/**
 * A file that is there but refuses connections is a dead poller's socket.
 * Node reports ECONNREFUSED for it; Bun reports ENOENT.
 */
const STALE: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOENT"])

/** The first characters of a line a pane sent: enough to recognise, too few to hold a token. */
const LOGGED_PREFIX = 20

/** Who holds the socket path now: this server's file, nobody, or a newer poller. */
type PathOwner = "ours" | "missing" | "other"

interface Connection {
  socket: Socket
  helloed: boolean
}

/** Exposes a PollerCore to panes over a Unix socket as newline-delimited JSON. */
export class PollerServer {
  private readonly server: Server
  private readonly connections = new Map<string, Connection>()
  private readonly lingerMs: number
  private readonly socketCheckMs: number
  private readonly log: (line: string) => void
  private readonly onIdle: () => void
  private nextId = 0
  private listening = false
  /** The socket file this server bound, so a replacement at the same path is told apart. */
  private identity?: { dev: number; ino: number }
  private started = false
  private lingerTimer?: ReturnType<typeof setTimeout>
  private checkTimer?: ReturnType<typeof setInterval>
  private closing?: Promise<void>

  constructor(
    private readonly core: PollerCore,
    private readonly opts: ServerOptions,
  ) {
    this.lingerMs = opts.lingerMs ?? LINGER_MS
    this.socketCheckMs = opts.socketCheckMs ?? SOCKET_CHECK_MS
    this.log = opts.log ?? (() => {})
    this.onIdle = opts.onIdle ?? (() => {})
    this.server = createServer((socket) => this.accept(socket))
    core.onSnapshot((clientId, snapshot) => {
      const connection = this.connections.get(clientId)
      if (connection) this.write(connection.socket, { type: "snapshot", snapshot })
    })
    core.onBudget((budget) => {
      this.log(
        `budget remaining=${budget.remaining}/${budget.limit} paused=${!!budget.pausedUntil}`,
      )
      for (const { socket } of this.connections.values()) {
        this.write(socket, { type: "budget", budget })
      }
    })
  }

  /** mkdir -p 0700 the directory; listen. Rejects with the EADDRINUSE error untouched. */
  async listen(): Promise<void> {
    mkdirSync(dirname(this.opts.socketPath), { recursive: true, mode: 0o700 })
    // Node refuses to bind over any existing file (EADDRINUSE), live or not,
    // and Bun silently replaces even a live socket, so ask first.
    if (existsSync(this.opts.socketPath)) {
      const outcome = await probe(this.opts.socketPath)
      if (outcome === "connected") {
        throw Object.assign(
          new Error(`listen EADDRINUSE: address already in use ${this.opts.socketPath}`),
          {
            code: "EADDRINUSE",
            syscall: "listen",
            address: this.opts.socketPath,
          },
        )
      }
      // Nothing answers: a dead poller's file. listen(path) binds and listens
      // in one call, so if another poller binds between this unlink and our
      // bind, ours fails with EADDRINUSE and that poller serves the panes.
      if (STALE.has(outcome)) {
        try {
          unlinkSync(this.opts.socketPath)
          this.log(`removed stale socket file ${this.opts.socketPath}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once("error", onError)
      this.server.listen(this.opts.socketPath, () => {
        this.server.off("error", onError)
        this.server.on("error", (error) => this.log(`server error: ${error.message}`))
        this.listening = true
        // The directory is 0700 already; this keeps the socket owner-only
        // even where that directory existed with looser permissions.
        try {
          chmodSync(this.opts.socketPath, 0o600)
        } catch {}
        const { dev, ino } = statSync(this.opts.socketPath)
        this.identity = { dev, ino }
        this.checkTimer = setInterval(() => this.checkSocket(), this.socketCheckMs)
        this.checkTimer.unref()
        // A poller nobody ever connects to must not run forever either.
        this.startLinger()
        this.log(`listening on ${this.opts.socketPath}`)
        resolve()
      })
    })
  }

  /** Stops timers, ends clients, closes the server, unlinks the socket file. */
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.cancelLinger()
    if (this.checkTimer) clearInterval(this.checkTimer)
    if (this.started) this.core.stop()
    const sockets = [...this.connections.values()].map((c) => c.socket)
    for (const [clientId, { socket }] of this.connections) {
      this.core.unsubscribe(clientId)
      socket.end()
      // server.close() waits for every connection; a peer that never answers the FIN must not stall it.
      setTimeout(() => socket.destroy(), END_GRACE_MS).unref()
    }
    this.connections.clear()
    if (!this.listening) return
    if (this.pathOwner() === "other") {
      // A newer poller holds the path. Node's server.close() unlinks a pipe
      // server's path unconditionally, which would delete the newcomer's file
      // and leave two pollers running, so the server is never closed here: its
      // fd is unreachable by path and dies with the process (onIdle exits).
      // unref() keeps it from holding the event loop open meanwhile.
      for (const socket of sockets) socket.destroy()
      this.server.unref()
      return
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    // Node has usually unlinked the path already; this covers runtimes that do
    // not, and never touches a file a newer poller bound in the meantime.
    if (this.pathOwner() !== "ours") return
    try {
      unlinkSync(this.opts.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  private pathOwner(): PathOwner {
    try {
      const { dev, ino } = statSync(this.opts.socketPath)
      return dev === this.identity?.dev && ino === this.identity.ino ? "ours" : "other"
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
      throw error
    }
  }

  private accept(socket: Socket): void {
    const clientId = `c${++this.nextId}`
    const connection: Connection = { socket, helloed: false }
    this.connections.set(clientId, connection)
    this.cancelLinger()
    if (!this.started) {
      this.started = true
      this.core.start()
    }
    this.log(`${clientId} connected`)
    socket.setEncoding("utf8")
    let buffer = ""
    socket.on("data", (data: string) => {
      const { messages, bad, rest } = decodeLines(buffer + data)
      buffer = rest
      // Never the whole line: a truncated watch line would put the Buildkite token in the log.
      for (const line of bad) {
        this.log(`${clientId} bad line (${line.length} chars): ${line.slice(0, LOGGED_PREFIX)}`)
      }
      for (const message of messages) {
        if (socket.destroyed) return
        if (isPaneMessage(message)) this.handle(clientId, connection, message)
        else {
          const text = JSON.stringify(message)
          const prefix = text.slice(0, LOGGED_PREFIX)
          this.log(`${clientId} unknown message (${text.length} chars): ${prefix}`)
        }
      }
      if (buffer.length > MAX_LINE_BYTES) {
        this.log(`${clientId} sent over 1 MiB without a newline; disconnecting`)
        socket.destroy()
      }
    })
    socket.on("error", (error) => this.log(`${clientId} socket error: ${error.message}`))
    socket.on("close", () => this.drop(clientId))
  }

  private handle(clientId: string, connection: Connection, message: PaneMessage): void {
    const { socket } = connection
    if (!connection.helloed) {
      if (message.type !== "hello") {
        this.log(`${clientId} sent ${message.type} before hello; disconnecting`)
        socket.end()
      } else if (message.version !== this.opts.version) {
        this.log(`${clientId} version ${message.version} != ${this.opts.version}; disconnecting`)
        socket.end()
      } else {
        connection.helloed = true
        this.log(`${clientId} hello pid=${message.pid}`)
      }
      return
    }
    switch (message.type) {
      case "hello":
        return
      case "watch":
        this.cancelLinger()
        this.core.subscribe(clientId, message.subscription)
        return
      case "refresh":
        void this.core.refresh(clientId, message.repositories)
        return
      case "older":
        void this.core
          .older(message.repositories, message.before, message.limit)
          .then(({ runs, diagnostics }) =>
            this.write(socket, { type: "older-result", id: message.id, runs, diagnostics }),
          )
        return
    }
  }

  private drop(clientId: string): void {
    if (!this.connections.delete(clientId)) return
    this.log(`${clientId} disconnected`)
    this.core.unsubscribe(clientId)
    if (this.core.clientCount === 0) this.startLinger()
  }

  private write(socket: Socket, message: PollerMessage): void {
    if (socket.destroyed || !socket.writable) return
    socket.write(encode(message))
  }

  private startLinger(): void {
    if (this.lingerTimer || this.closing) return
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = undefined
      this.log("no clients; exiting")
      this.stop()
    }, this.lingerMs)
    this.lingerTimer.unref()
  }

  private cancelLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer)
    this.lingerTimer = undefined
  }

  private checkSocket(): void {
    const owner = this.pathOwner()
    if (owner === "ours") return
    this.log(owner === "missing" ? "socket file is gone; exiting" : "socket file replaced; exiting")
    this.stop()
  }

  private stop(): void {
    this.close().then(
      () => this.onIdle(),
      (error: unknown) => {
        this.log(`close failed: ${error instanceof Error ? error.message : String(error)}`)
        this.onIdle()
      },
    )
  }
}

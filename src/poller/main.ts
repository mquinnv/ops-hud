import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execa } from "execa"
import { BuildkiteProvider } from "../providers/buildkite.js"
import { PollerCore } from "./core.js"
import { GitHubPoller, resolveGitHubToken } from "./github-poller.js"
import { socketPath } from "./protocol.js"
import { PollerServer } from "./server.js"

export const MAX_LOG_BYTES = 1024 * 1024

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"))

/** One line per event, ISO timestamp first; the file is truncated once it passes MAX_LOG_BYTES. */
function fileLogger(file: string): (line: string) => void {
  return (line) => {
    try {
      let size = 0
      try {
        size = statSync(file).size
      } catch {}
      const entry = `${new Date().toISOString()} ${line}\n`
      if (size > MAX_LOG_BYTES) writeFileSync(file, entry)
      else appendFileSync(file, entry)
    } catch {
      // A log that cannot be written must not take the poller down.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The hidden `__poller` command: serves one PollerCore on this machine's socket until idle. */
export async function runPoller(): Promise<void> {
  const path = socketPath({
    env: process.env,
    version: packageJson.version,
    entryScript: process.argv[1] ?? "",
    home: homedir(),
  })
  const log = fileLogger(join(dirname(path), "poller.log"))
  const github = new GitHubPoller({
    resolveToken: () => resolveGitHubToken(process.env, (file, args) => execa(file, args)),
  })
  const core = new PollerCore({
    github,
    buildkiteFactory: (opts) => new BuildkiteProvider(opts),
    onError: (error) => log(`error: ${messageOf(error)}`),
  })
  const server = new PollerServer(core, {
    socketPath: path,
    version: packageJson.version,
    log,
    onIdle: () => process.exit(0),
  })

  const shutdown = async () => {
    await server.close()
    process.exit(0)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  try {
    await server.listen()
  } catch (error) {
    // Another poller won the race to the socket; it serves the panes.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") process.exit(0)
    process.stderr.write(`ops-hud poller: cannot listen on ${path}: ${messageOf(error)}\n`)
    process.exit(1)
  }
  log(`poller ${packageJson.version} pid=${process.pid} started`)
}

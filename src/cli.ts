import { Command } from "commander"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { App } from "./app.js"
import { resolveScope } from "./config.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"))

export interface WatchOptions {
  repo?: string[]
  config?: string
  org?: string[]
  interval: string
  showPrs?: boolean
  showDocker?: boolean
  bkOrg?: string
  pipeline?: string[]
  // Commander's `--no-X` convention: absent means true (the default), and
  // `--no-buildkite`/`--no-github` set these to `false` explicitly.
  buildkite?: boolean
  github?: boolean
}

async function watch(path: string | undefined, options: WatchOptions): Promise<void> {
  // Resolve the path scope before blessed takes the screen — an error raised
  // once the UI is up is an invisible empty dashboard.
  let scopedRepository: string | undefined
  let scopeDir: string | undefined
  if (path) {
    try {
      const scope = await resolveScope(path)
      scopedRepository = scope.repo
      scopeDir = scope.dir
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
      process.exit(1)
    }
  }

  const app = new App()

  try {
    await app.initialize({
      repositories: options.repo,
      config: options.config,
      organizations: options.org,
      interval: parseInt(options.interval, 10),
      showPRs: options.showPrs,
      showDocker: options.showDocker,
      scopedRepository,
      scopeDir,
      noGithub: options.github === false,
      noBuildkite: options.buildkite === false,
      bkOrg: options.bkOrg,
      pipelines: options.pipeline,
    })
  } catch (error) {
    // Write to stderr in a way that won't interfere with the UI
    process.stderr.write(`Failed to initialize app: ${error}\n`)
    process.exit(1)
  }

  // Handle graceful shutdown
  const cleanup = () => {
    app.stop()
    process.exit(0)
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("SIGUSR1", cleanup)
  process.on("SIGUSR2", cleanup)

  // Handle uncaught exceptions
  process.on("uncaughtException", (_error) => {
    // Don't output to console as it interferes with UI
    cleanup()
  })
}

// Both the bare invocation and the explicit `watch` subcommand take the same
// arguments, so register them from one place. Exported so tests can attach a
// harmless action to a throwaway Command and assert on the parsed options
// without invoking `watch()` (which touches `gh`/git and the terminal).
export function addWatchOptions(command: Command): Command {
  return command
    .argument(
      "[path]",
      "Path to a checkout; monitors only that repository (e.g. '.' or ~/Projects/remix)",
    )
    .option("-r, --repo <repositories...>", "Specific repositories to watch (format: owner/repo)")
    .option("-c, --config <path>", "Path to configuration file")
    .option("-o, --org <organizations...>", "Organizations to monitor")
    .option("-i, --interval <seconds>", "Refresh interval in seconds", "5")
    .option("-p, --show-prs", "Show open pull requests in header")
    .option("-d, --show-docker", "Show Docker Compose service status in header")
    .option("--bk-org <org>", "Buildkite organization slug")
    .option("--pipeline <slugs...>", "Buildkite pipeline slugs to watch")
    .option("--no-buildkite", "Disable the Buildkite provider")
    .option("--no-github", "Disable the GitHub provider")
}

/**
 * Builds a fresh commander program on every call — never a shared module-level
 * singleton. Importing this module must have no side effects (no argv
 * parsing, nothing started): `index.ts` is the only caller that parses real
 * argv, and tests get an isolated program each time instead of sharing
 * mutable global commander state.
 */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name("ops-hud")
    .description("CI and ops dashboard for the terminal — GitHub Actions and Buildkite")
    .version(packageJson.version)

  addWatchOptions(program.command("watch").description("Watch CI runs")).action(watch)

  // Default command (same as watch)
  addWatchOptions(program).action(watch)

  // Spawned by panes; one per machine and version, shared by all of them.
  program
    .command("__poller", { hidden: true })
    .description("internal: shared poller")
    // Loaded lazily so a pane start does not pull in the poller's dependencies.
    .action(async () => (await import("./poller/main.js")).runPoller())

  return program
}

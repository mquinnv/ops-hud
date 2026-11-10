import { exec } from "child_process"
import { promisify } from "util"
import { ConfigManager } from "./config.js"
import { Dashboard } from "./dashboard.js"
import { DockerServiceManager } from "./docker-utils.js"
import { createPollerClient, type PollerClient } from "./poller/client.js"
import type { BuildkiteSubscription, Snapshot } from "./poller/protocol.js"
import {
  BUILDKITE_NO_TOKEN,
  BuildkiteProvider,
  type BuildkiteProviderOptions,
  resolveBuildkiteToken,
} from "./providers/buildkite.js"
import { GitHubProvider } from "./providers/github.js"
import { applyIsFailing } from "./providers/github-map.js"
import type { CiProvider, ProviderDiagnostic } from "./providers/types.js"
import { rerunVerb, runNoun } from "./run-wording.js"
import { isActive, type RunStatus } from "./status.js"
import type { DockerServiceStatus, Job, PullRequest, Run } from "./types.js"
import { readPackageVersion } from "./version.js"

const execAsync = promisify(exec)

// A run created up to this long before ops-hud started still counts as having
// happened while it was watching: provider timestamps and the local clock can
// disagree by a few seconds.
const CLOCK_SKEW_GRACE_MS = 30_000

/** Pull requests are polled by the pane on their own timer, apart from CI runs. */
export const PR_REFRESH_MS = 30_000

/**
 * After `r`, the pane stops the status-bar spinner itself after this long: the
 * poller sends no snapshot when nothing changed, and only a snapshot stops it.
 */
export const REFRESH_SPINNER_MS = 2_000

/** Substitutions for the tests; production constructs every one of these. */
export interface AppDependencies {
  github?: GitHubProvider
  providers?: CiProvider[]
  dockerService?: DockerServiceManager
  configManager?: ConfigManager
  dashboard?: Dashboard
  /**
   * Seam for observing what the Buildkite provider was constructed with,
   * without touching the network. Production builds a real BuildkiteProvider.
   */
  buildkiteFactory?: (options: BuildkiteProviderOptions) => CiProvider
  /** Clock, for deciding which runs happened while ops-hud was watching. */
  now?: () => number
  /**
   * Where runs come from. Absent, initialize() builds the production client,
   * which joins or spawns the shared poller process.
   */
  pollerClient?: PollerClient
  /** How long `r`'s spinner may run with no snapshot; REFRESH_SPINNER_MS by default. */
  refreshSpinnerMs?: number
}

export class App {
  // Pull requests and repository listing are GitHub-only concerns that are not
  // on CiProvider, so the GitHub provider is also held by its concrete type.
  private github: GitHubProvider
  // The pane-side actions (cancel, rerun, logs). Runs themselves come from
  // the poller, never from these.
  private providers: CiProvider[]
  // True when AppDependencies.providers was supplied (the tests' seam). In
  // that case initialize() must never overwrite the injected list with one
  // built from config/flags. Recorded here, rather than inferred from array
  // contents, so an injected empty array or a single-provider list is just as
  // protected as any other.
  private readonly providersInjected: boolean
  private readonly buildkiteFactory: (options: BuildkiteProviderOptions) => CiProvider
  // What the Buildkite provider was built with, passed on to the poller.
  // Undefined when Buildkite is off or has no token.
  private buildkiteSubscription?: BuildkiteSubscription
  private pollerClient?: PollerClient
  private dockerService: DockerServiceManager
  private configManager: ConfigManager
  private dashboard: Dashboard
  private prTimer?: NodeJS.Timeout
  private dockerTimer?: NodeJS.Timeout
  private prPollInFlight = false
  private dockerPollInFlight = false
  // PR and Docker polls only re-render once a snapshot has drawn the grid;
  // before that they just store their data for the first snapshot to show.
  private hasSnapshot = false
  // Stops the spinner `r` starts when no snapshot arrives to stop it.
  private refreshSpinnerTimer?: NodeJS.Timeout
  private readonly refreshSpinnerMs: number
  private repositories: string[] = []
  private jobs: Map<string, Job[]> = new Map() // Keyed by Run.key
  private watchedWorkflows: Set<string> = new Set() // Run keys we've been watching
  private completedWorkflows: Map<string, Run> = new Map() // Keep finished runs until dismissed
  // When ops-hud started watching. A run that finished after this happened
  // while the user was watching, even if it started and finished between two
  // fetches and so was never seen in flight — Buildkite is only fetched every
  // 15s. See finishedInWindow().
  private readonly watchingSince: number
  // Finished runs the user dismissed. A run created after watchingSince would
  // otherwise be re-added on the next refresh.
  private dismissedRuns: Set<string> = new Set()
  // Blocked runs the user dismissed, with the status they had at the time.
  // Hidden only while that status holds: once unblocked, canceled or
  // anything else, the run comes back.
  private dismissedBlocked: Map<string, RunStatus> = new Map()
  private showPRs = false
  private pullRequests: PullRequest[] = []
  private showDocker = false
  private dockerServices: DockerServiceStatus[] = []
  private oldestWorkflowTimestamp?: string // Track the oldest workflow timestamp for resurrect feature
  // Diagnostics from the most recent refresh, surfaced in the dashboard's
  // empty-state panel when the grid has no cards at all.
  private lastDiagnostics: ProviderDiagnostic[] = []
  // The diagnostic messages the previous refresh produced. A diagnostic is
  // written to the event log only when it was not in that set, so a steady
  // "no token — skipped" is logged once rather than every 5s, where it would
  // push real events out of the log buffer.
  private previousDiagnosticMessages: Set<string> = new Set()
  // Set by --no-buildkite, so an empty grid says why there are no builds.
  private buildkiteDisabled = false
  // Buildkite is on but there is no token, so no Buildkite subscription went
  // to the poller and it cannot say so: the pane adds the diagnostic itself.
  private buildkiteNoToken = false

  constructor(deps: AppDependencies = {}) {
    this.github = deps.github ?? new GitHubProvider()
    this.providersInjected = deps.providers !== undefined
    this.providers = deps.providers ?? [this.github]
    this.buildkiteFactory = deps.buildkiteFactory ?? ((options) => new BuildkiteProvider(options))
    this.dockerService = deps.dockerService ?? new DockerServiceManager()
    this.configManager = deps.configManager ?? new ConfigManager()
    // Constructing a Dashboard takes the terminal, so a caller that supplies
    // one (the tests) must be able to keep that from happening.
    this.dashboard = deps.dashboard ?? new Dashboard()
    this.watchingSince = (deps.now ?? Date.now)()
    // Never constructed here: the production client is built in initialize().
    this.pollerClient = deps.pollerClient
    this.refreshSpinnerMs = deps.refreshSpinnerMs ?? REFRESH_SPINNER_MS
  }

  private clearRefreshSpinnerTimer(): void {
    clearTimeout(this.refreshSpinnerTimer)
    this.refreshSpinnerTimer = undefined
  }

  async initialize(args: {
    config?: string
    repositories?: string[]
    organizations?: string[]
    interval?: number
    showPRs?: boolean
    showDocker?: boolean
    scopedRepository?: string
    scopeDir?: string
    noGithub?: boolean
    noBuildkite?: boolean
    bkOrg?: string
    pipelines?: string[]
  }): Promise<void> {
    // Load configuration, and say which file it came from: a legacy
    // ./.gh-hud.json silently shadowed by a newer ~/.ops-hud.json (or the
    // reverse) is otherwise invisible.
    await this.configManager.loadConfig(args.config)
    const loadedPath = this.configManager.loadedPath
    this.dashboard.log(
      loadedPath ? `Config: loaded ${loadedPath}` : "Config: no config file found, using defaults",
      "info",
    )

    // Config is only known once loadConfig has run, so the provider list
    // (which needs buildkite.token/org/pipelines) is built here, never in the
    // constructor. Injected providers (the tests' seam) are never overwritten.
    if (!this.providersInjected) {
      this.providers = this.buildProviders(args)
    }
    this.buildkiteDisabled = args.noBuildkite === true

    // A path argument or -r is a hard scope, not an addition to whatever the
    // config file happens to list — otherwise configured orgs widen it back out.
    const scoped = args.scopedRepository ? [args.scopedRepository] : args.repositories
    if (scoped?.length) {
      this.configManager.setScopedRepositories(scoped)
    }
    if (args.scopeDir) {
      this.dockerService.setScopeDir(args.scopeDir)
    }
    if (args.organizations?.length) {
      this.configManager.updateFromArgs({ organizations: args.organizations })
    }
    if (args.interval) {
      this.configManager.updateFromArgs({ refreshInterval: args.interval * 1000 })
    }

    // Store the showPRs and showDocker flags
    this.showPRs = args.showPRs || false
    this.showDocker = args.showDocker || false

    // Build repository list
    this.repositories = await this.configManager.buildRepositoryList(this.github, this.dashboard)

    if (this.repositories.length === 0) {
      // Will show empty state in UI
      this.repositories = []
    }

    // Set up event handlers
    this.setupEventHandlers()

    // Runs come from the poller from here on; the pane never fetches them.
    this.pollerClient ??= createPollerClient({ version: readPackageVersion() })
    const client = this.pollerClient
    client.onSnapshot((snapshot) => this.applySnapshot(snapshot))
    client.onBudget((budget) => this.dashboard.setBudget(budget))
    client.onStatus((status) => {
      this.dashboard.setPollerStatus(status)
      this.dashboard.log(status.message, "info")
    })
    await client.start?.()
    // Straight after start, with no await in between: a poller that dies
    // before the first watch sends the pane in-process until the next rejoin.
    client.watch({
      repositories: this.repositories,
      interval: this.configManager.refreshInterval,
      github: !args.noGithub,
      ...(this.buildkiteSubscription ? { buildkite: this.buildkiteSubscription } : {}),
    })

    if (this.showPRs) {
      void this.pollPullRequests()
      this.prTimer = setInterval(() => void this.pollPullRequests(), PR_REFRESH_MS)
      this.prTimer.unref()
    }
    if (this.showDocker) {
      void this.pollDocker()
      this.dockerTimer = setInterval(
        () => void this.pollDocker(),
        this.configManager.refreshInterval,
      )
      this.dockerTimer.unref()
    }
  }

  /**
   * Builds the CI provider list from config and CLI flags. `--no-github`
   * disables GitHub *runs* only — `this.github` is kept regardless, for PRs
   * and repository resolution, neither of which is on this list.
   */
  private buildProviders(args: {
    noGithub?: boolean
    noBuildkite?: boolean
    bkOrg?: string
    pipelines?: string[]
  }): CiProvider[] {
    const providers: CiProvider[] = []
    this.buildkiteSubscription = undefined
    this.buildkiteNoToken = false
    if (!args.noGithub) {
      providers.push(this.github)
    }
    if (!args.noBuildkite) {
      const buildkiteConfig = this.configManager.buildkite
      const options = {
        token: resolveBuildkiteToken(process.env, buildkiteConfig),
        org: args.bkOrg ?? buildkiteConfig.org,
        pipelines: args.pipelines ?? buildkiteConfig.pipelines,
      }
      providers.push(this.buildkiteFactory(options))
      if (options.token) {
        this.buildkiteSubscription = {
          token: options.token,
          org: options.org,
          pipelines: options.pipelines,
        }
      } else {
        this.buildkiteNoToken = true
      }
    }
    return providers
  }

  private setupEventHandlers(): void {
    // Manual refresh: ask the poller now; PRs and Docker are re-read too.
    this.dashboard.onRefresh(() => {
      this.dashboard.showLoadingInStatus()
      this.pollerClient?.refresh()
      // Only a snapshot stops the spinner, and the poller sends none when
      // nothing changed: stop it ourselves after a moment.
      this.clearRefreshSpinnerTimer()
      this.refreshSpinnerTimer = setTimeout(() => {
        this.refreshSpinnerTimer = undefined
        this.dashboard.stopRefreshAnimation()
      }, this.refreshSpinnerMs)
      this.refreshSpinnerTimer.unref()
      if (this.showPRs) void this.pollPullRequests()
      if (this.showDocker) void this.pollDocker()
    })

    // Handle application exit
    this.dashboard.onExit(() => {
      this.stop()
    })

    // Handle opening a run in browser
    this.dashboard.onOpenRun(async (run: Run) => {
      try {
        const url = run.webUrl
        const platform = process.platform

        let command: string
        if (platform === "darwin") {
          command = `open "${url}"`
        } else if (platform === "win32") {
          command = `start "${url}"`
        } else {
          command = `xdg-open "${url}"`
        }

        await execAsync(command)
      } catch (_error) {
        // Silently fail
      }
    })

    // Handle opening PR in browser
    this.dashboard.onOpenPR(async (pr: PullRequest) => {
      try {
        const url = pr.url
        const platform = process.platform

        let command: string
        if (platform === "darwin") {
          command = `open "${url}"`
        } else if (platform === "win32") {
          command = `start "${url}"`
        } else {
          command = `xdg-open "${url}"`
        }

        await execAsync(command)
        this.dashboard.log(`Opened PR #${pr.number}: ${pr.title}`, "info")
      } catch (_error) {
        // Silently fail
      }
    })

    // Handle dismissing finished runs
    this.dashboard.onDismissRun((run: Run) => {
      this.dismissRun(run.key, run.status)
    })

    // Handle dismissing all finished runs
    this.dashboard.onDismissAllCompleted((runs: Run[]) => {
      this.dismissAllCompletedRuns(runs)
    })

    // Handle resurrect older run
    this.dashboard.onResurrectRun(() => {
      this.resurrectOldestRun()
    })

    // Handle killing/cancelling a run
    this.dashboard.onKillRun(async (run: Run) => {
      const provider = this.providerFor(run)
      if (!provider) {
        this.dashboard.log(`No provider for ${run.provider}`, "error")
        return
      }

      const noun = runNoun(run)
      try {
        this.dashboard.log(`Cancelling ${noun} ${run.id} in ${run.repo.fullName}...`, "info")
        await provider.cancel(run)

        this.dashboard.log(`Successfully cancelled ${noun} ${run.id}`, "info")
        // Have the poller look at this repository again now
        this.pollerClient?.refresh([run.repo.fullName])
      } catch (error) {
        this.dashboard.log(`Failed to cancel ${noun}: ${error}`, "error")
      }
    })

    // Handle Docker service actions
    this.dashboard.onDockerAction(
      async (
        action: string,
        dockerService: {
          service: { name: string; state: string }
          repo: string
          composeFile?: string
          isProject?: boolean
        },
      ) => {
        try {
          const serviceName = dockerService.service.name
          const repo = dockerService.repo
          const composeFile = dockerService.composeFile

          // Use compose file path if available, otherwise fall back to repo lookup
          let repoPath = ""
          if (composeFile) {
            // Extract directory from compose file path
            const pathParts = composeFile.split("/")
            pathParts.pop() // Remove filename
            repoPath = pathParts.join("/")
          } else {
            // Fallback to old method
            const repository = this.repositories.find((r) => r.includes(repo))
            if (!repository) {
              this.dashboard.log(`Could not find repository path for ${repo}`, "error")
              return
            }
            repoPath = repository.startsWith("/") ? repository : process.cwd()
          }

          let command = ""

          switch (action) {
            case "start":
              this.dashboard.log(`Starting Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose start ${serviceName}`
              break
            case "stop":
              this.dashboard.log(`Stopping Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose stop ${serviceName}`
              break
            case "restart":
              this.dashboard.log(`Restarting Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose restart ${serviceName}`
              break
            case "recreate":
              this.dashboard.log(`Recreating Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose up -d --force-recreate ${serviceName}`
              break
            case "logs": {
              this.dashboard.log(
                `Showing logs for Docker service ${serviceName} in ${repo}...`,
                "info",
              )
              // For logs, we might want to show them in a box or open a new terminal
              command = `cd ${repoPath} && docker compose logs --tail=50 ${serviceName}`
              const { stdout } = await execAsync(command)
              this.dashboard.log(stdout, "info")
              return // Don't refresh for logs
            }
            case "shell":
              this.dashboard.log(
                `Opening shell for Docker service ${serviceName} in ${repo}...`,
                "info",
              )
              // This is tricky - might need to spawn a new terminal or pause blessed
              command = `cd ${repoPath} && docker compose exec ${serviceName} sh`
              this.dashboard.log(`Run manually: ${command}`, "info")
              return // Can't easily do interactive shell
            case "up":
              this.dashboard.log(`Starting all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose up -d`
              break
            case "start-all":
              this.dashboard.log(`Starting all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose start`
              break
            case "stop-all":
              this.dashboard.log(`Stopping all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose stop`
              break
            case "down":
              this.dashboard.log(`Taking down all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose down`
              break
            case "logs-all": {
              this.dashboard.log(`Showing logs for all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose logs --tail=50`
              const { stdout } = await execAsync(command)
              this.dashboard.log(stdout, "info")
              return // Don't refresh for logs
            }
            default:
              this.dashboard.log(`Unknown Docker action: ${action}`, "error")
              return
          }

          await execAsync(command)
          const target = dockerService.isProject ? `project ${repo}` : `service ${serviceName}`
          this.dashboard.log(`Successfully completed ${action} on ${target}`, "info")

          // Re-read Docker status to show the change
          await this.pollDocker()
        } catch (error) {
          this.dashboard.log(`Failed to ${action} Docker service: ${error}`, "error")
        }
      },
    )

    // Handle PR merge
    this.dashboard.onPRMerge(async (pr: PullRequest, method: string) => {
      try {
        const repoName = `${pr.repository.owner}/${pr.repository.name}`
        this.dashboard.log(`Merging PR #${pr.number} using ${method} method...`, "info")

        const command = `gh pr merge ${pr.number} -R ${repoName} --${method}`
        await execAsync(command)

        this.dashboard.log(`Successfully merged PR #${pr.number}`, "info")
        await this.pollPullRequests()
      } catch (error) {
        this.dashboard.log(`Failed to merge PR: ${error}`, "error")
      }
    })

    // Handle PR checkout
    this.dashboard.onPRCheckout(async (pr: PullRequest) => {
      try {
        const repoName = `${pr.repository.owner}/${pr.repository.name}`
        this.dashboard.log(`Checking out PR #${pr.number} branch ${pr.headRefName}...`, "info")

        const command = `gh pr checkout ${pr.number} -R ${repoName}`
        await execAsync(command)

        this.dashboard.log(`Successfully checked out PR #${pr.number}`, "info")
      } catch (error) {
        this.dashboard.log(`Failed to checkout PR: ${error}`, "error")
      }
    })

    // Handle PR actions (draft/ready)
    this.dashboard.onPRAction(async (action: string, pr: PullRequest) => {
      try {
        const repoName = `${pr.repository.owner}/${pr.repository.name}`

        if (action === "ready") {
          this.dashboard.log(`Marking PR #${pr.number} as ready for review...`, "info")
          const command = `gh pr ready ${pr.number} -R ${repoName}`
          await execAsync(command)
          this.dashboard.log(`Successfully marked PR #${pr.number} as ready`, "info")
        } else if (action === "draft") {
          this.dashboard.log(`Converting PR #${pr.number} to draft...`, "info")
          const command = `gh pr edit ${pr.number} -R ${repoName} --draft`
          await execAsync(command)
          this.dashboard.log(`Successfully converted PR #${pr.number} to draft`, "info")
        }

        await this.pollPullRequests()
      } catch (error) {
        this.dashboard.log(`Failed to ${action} PR: ${error}`, "error")
      }
    })

    // Handle run rerun
    this.dashboard.onRunRerun(async (run: Run) => {
      const provider = this.providerFor(run)
      if (!provider) {
        this.dashboard.log(`No provider for ${run.provider}`, "error")
        return
      }

      const verb = rerunVerb(run)
      try {
        this.dashboard.log(`Triggering a ${verb} of ${run.id} in ${run.repo.fullName}...`, "info")
        await provider.rerun(run)

        this.dashboard.log(`Successfully triggered a ${verb} of ${run.id}`, "info")
        this.pollerClient?.refresh([run.repo.fullName])
      } catch (error) {
        this.dashboard.log(`Failed to trigger a ${verb}: ${error}`, "error")
      }
    })

    // Handle run logs
    this.dashboard.onRunLogs(async (run: Run) => {
      const provider = this.providerFor(run)
      if (!provider) {
        this.dashboard.log(`No provider for ${run.provider}`, "error")
        return
      }

      const noun = runNoun(run)
      try {
        this.dashboard.log(`Fetching logs for ${noun} ${run.id}...`, "info")
        const output = await provider.logs(run)

        // Show first 20 lines of logs in the dashboard
        const logLines = output.split("\n")
        logLines.slice(0, 20).forEach((line) => {
          this.dashboard.log(line, "info")
        })

        if (logLines.length > 20) {
          this.dashboard.log(
            `... (truncated, ${logLines.length} lines total; open the ${noun} for full logs)`,
            "info",
          )
        }
      } catch (error) {
        this.dashboard.log(`Failed to fetch logs for ${noun}: ${error}`, "error")
      }
    })
  }

  private providerFor(run: Run): CiProvider | undefined {
    return this.providers.find((p) => p.name === run.provider)
  }

  /**
   * One poll's worth of runs from the poller: tracks what was watched,
   * finished and dismissed, then renders. Every snapshot goes through this,
   * even one identical to the last, and even under an open modal: the poller
   * sends a snapshot only when the view changed, so one skipped here would
   * never come again. The dashboard stores the data and draws it once the
   * modal closes.
   */
  applySnapshot(snapshot: Snapshot): void {
    // updateWorkflows stops the refresh spinner itself.
    this.clearRefreshSpinnerTimer()
    try {
      this.trackAndRender(snapshot)
    } catch (error) {
      // The client's listener wrapper would swallow this silently.
      this.dashboard.log(`Error applying snapshot: ${error}`, "error")
    }
  }

  private trackAndRender(snapshot: Snapshot): void {
    // The only budget a pane joining an established poller gets: the poller
    // broadcasts budget messages on change only.
    if (snapshot.budget) this.dashboard.setBudget(snapshot.budget)
    const snapshotJobs = new Map<string, Job[]>(Object.entries(snapshot.jobs))
    const diagnostics = [...snapshot.diagnostics]
    if (this.buildkiteDisabled) {
      diagnostics.push({
        provider: "buildkite",
        level: "info",
        message: "Buildkite: disabled (--no-buildkite)",
      })
    } else if (this.buildkiteNoToken) {
      diagnostics.push({
        provider: "buildkite",
        level: "info",
        message: BUILDKITE_NO_TOKEN,
      })
    }
    this.logChangedDiagnostics(diagnostics)
    const allRuns = [...snapshot.runs].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )

    // Kept for the empty-state panel: a Buildkite misconfiguration on a
    // checkout with no GitHub Actions runs must not look like idle CI.
    this.lastDiagnostics = diagnostics

    // Update watched and completed trackers, keyed by Run.key: ids are only
    // unique within a provider.
    for (const run of allRuns) {
      if (isActive(run.status)) {
        this.watchedWorkflows.add(run.key)
        // Running again (a GitHub rerun keeps its key): an earlier
        // dismissal no longer applies.
        this.dismissedRuns.delete(run.key)
      } else if (
        !this.completedWorkflows.has(run.key) &&
        !this.dismissedRuns.has(run.key) &&
        (this.watchedWorkflows.has(run.key) || this.finishedInWindow(run))
      ) {
        // Reached a verdict while being watched
        this.completedWorkflows.set(run.key, run)
      }
    }

    // Track the oldest timestamp for resurrect from GitHub runs only: only
    // GitHub can page backwards, and an old Buildkite build in the merged
    // list would otherwise make resurrect skip every GitHub run in between.
    const githubRuns = allRuns.filter((run) => run.provider === "github")
    if (githubRuns.length > 0) {
      const oldest = githubRuns.reduce((a, b) =>
        new Date(b.createdAt).getTime() < new Date(a.createdAt).getTime() ? b : a,
      )
      this.oldestWorkflowTimestamp = oldest.createdAt
    }

    // A dismissed blocked run whose status has moved on is no longer dismissed.
    for (const run of allRuns) {
      const dismissedAs = this.dismissedBlocked.get(run.key)
      if (dismissedAs !== undefined && dismissedAs !== run.status) {
        this.dismissedBlocked.delete(run.key)
      }
    }

    // Visible runs = active runs + finished ones pending confirmation, excluding dismissed
    const visibleRuns = allRuns.filter((run) => this.isVisible(run))

    // The jobs the poller sent, kept for every visible run.
    this.jobs.clear()
    for (const run of visibleRuns) {
      const jobs = snapshotJobs.get(run.key)
      if (jobs) this.jobs.set(run.key, jobs)
    }

    // A GitHub run that is still going but already has a failed job is
    // doomed; say so. Buildkite reports this itself (the build's `failing`
    // state, which the mapper already turned into isFailing) and that is
    // authoritative: deriving it from jobs would flag skipped or
    // soft-failed jobs as failures.
    const workflows = visibleRuns.map((run) =>
      run.provider === "github" ? applyIsFailing(run, this.jobs.get(run.key) ?? []) : run,
    )

    this.hasSnapshot = true
    this.render(workflows)
  }

  /** Re-reads open pull requests and re-renders the grid with them. */
  async pollPullRequests(): Promise<void> {
    if (this.prPollInFlight) return
    this.prPollInFlight = true
    try {
      this.pullRequests = await this.github.getAllPullRequests(this.repositories)
      if (this.hasSnapshot) this.render(this.dashboard.getCurrentWorkflows())
    } catch (error) {
      this.dashboard.log(`Failed to fetch pull requests: ${error}`, "error")
    } finally {
      this.prPollInFlight = false
    }
  }

  /** Re-reads Docker Compose status and re-renders the grid with it. */
  async pollDocker(): Promise<void> {
    if (this.dockerPollInFlight) return
    this.dockerPollInFlight = true
    try {
      this.dashboard.log(
        `Checking Docker services for repositories: ${this.repositories.join(", ")}`,
        "debug",
      )
      this.dockerServices = await this.dockerService.getAllDockerStatus(this.repositories, (msg) =>
        this.dashboard.log(msg, "debug"),
      )
      const totalServices = this.dockerServices.reduce((acc, ds) => acc + ds.services.length, 0)
      const logLevel = this.dockerServices.length > 0 ? "info" : "debug"
      this.dashboard.log(
        `Found ${this.dockerServices.length} compose files, ${totalServices} total services`,
        logLevel,
      )

      // Log which repos have Docker services
      if (this.dockerServices.length > 0) {
        const reposWithDocker = [...new Set(this.dockerServices.map((ds) => ds.repository))]
        this.dashboard.log(`Docker services found in: ${reposWithDocker.join(", ")}`, "debug")
      }
      if (this.hasSnapshot) this.render(this.dashboard.getCurrentWorkflows())
    } catch (error) {
      this.dashboard.log(`Failed to check Docker services: ${error}`, "error")
    } finally {
      this.dockerPollInFlight = false
    }
  }

  /** Draws these runs with the current jobs, PRs, Docker status and diagnostics. */
  private render(workflows: Run[]): void {
    // Only pass PRs/Docker data when those features are enabled
    this.dashboard.updateWorkflows(
      workflows,
      this.jobs,
      this.showPRs ? this.pullRequests : undefined,
      this.showDocker ? this.dockerServices : undefined,
      this.lastDiagnostics,
    )
  }

  /** Logs each diagnostic the previous snapshot did not also carry. */
  private logChangedDiagnostics(diagnostics: ProviderDiagnostic[]): void {
    const current = new Set<string>()
    for (const diagnostic of diagnostics) {
      if (current.has(diagnostic.message)) continue
      current.add(diagnostic.message)
      if (!this.previousDiagnosticMessages.has(diagnostic.message)) {
        this.dashboard.log(diagnostic.message, diagnostic.level === "error" ? "error" : "info")
      }
    }
    this.previousDiagnosticMessages = current
  }

  /**
   * Finished while ops-hud was watching, or in the recent-history window
   * (showCompletedFor minutes) before it started. The window is fixed at
   * launch, not rolling. Judged by when the run finished, falling back to when
   * it was created, and never narrower than the clock-skew grace.
   */
  private finishedInWindow(run: Run): boolean {
    const at = Date.parse(run.finishedAt ?? run.createdAt)
    const historyMs = this.configManager.showCompletedFor * 60_000
    const windowStart = this.watchingSince - Math.max(CLOCK_SKEW_GRACE_MS, historyMs)
    return !Number.isNaN(at) && at >= windowStart
  }

  /** Active and not a dismissed blocked run, or finished and still awaiting dismissal. */
  private isVisible(run: Run): boolean {
    if (this.dismissedBlocked.get(run.key) === run.status) return false
    if (isActive(run.status)) return true
    return this.completedWorkflows.has(run.key)
  }

  private dismissRun(key: string, status?: RunStatus): void {
    if (status === "blocked") {
      // Still in flight: keep watching it, just hide it while it stays blocked.
      this.dismissedBlocked.set(key, status)
      this.updateDisplayAfterDismiss()
      return
    }
    this.completedWorkflows.delete(key)
    this.watchedWorkflows.delete(key)
    this.dismissedRuns.add(key)
    // Update display immediately without API refresh
    this.updateDisplayAfterDismiss()
  }

  private dismissAllCompletedRuns(runs: Run[]): void {
    // Remove all finished runs from tracking
    runs.forEach((run) => {
      this.completedWorkflows.delete(run.key)
      this.watchedWorkflows.delete(run.key)
      this.dismissedRuns.add(run.key)
    })
    // Update display immediately without API refresh
    this.updateDisplayAfterDismiss()
  }

  private updateDisplayAfterDismiss(): void {
    // Get the last known workflows from the dashboard and filter out dismissed ones
    // This avoids an expensive API call just to update the display
    const currentWorkflows = this.dashboard.getCurrentWorkflows()
    const filteredWorkflows = currentWorkflows.filter((run) => this.isVisible(run))

    // Update dashboard with filtered workflows immediately
    this.render(filteredWorkflows)
  }

  async resurrectOldestRun(): Promise<void> {
    this.dashboard.log(
      `Resurrect called - timestamp: ${this.oldestWorkflowTimestamp}, repos: ${this.repositories.length}`,
      "info",
    )

    if (!this.oldestWorkflowTimestamp || this.repositories.length === 0) {
      this.dashboard.log("No older workflows available to resurrect", "info")
      return
    }

    try {
      this.dashboard.log(
        `Fetching older workflow before ${this.oldestWorkflowTimestamp}...`,
        "info",
      )

      // One run older than our oldest GitHub run; the poller pages GitHub only.
      const result = await this.pollerClient?.older(
        this.repositories,
        this.oldestWorkflowTimestamp,
        1,
      )
      for (const diagnostic of result?.diagnostics ?? []) {
        this.dashboard.log(diagnostic.message, diagnostic.level === "error" ? "error" : "info")
      }
      const olderWorkflows = [...(result?.runs ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )

      if (olderWorkflows.length === 0) {
        this.dashboard.log("No older workflows found", "info")
        return
      }

      // Get current workflows
      const currentWorkflows = this.dashboard.getCurrentWorkflows()

      // Add the older workflow as completed (so it shows up but is visually distinct)
      const resurrectedWorkflow = olderWorkflows[0]
      this.completedWorkflows.set(resurrectedWorkflow.key, resurrectedWorkflow)

      // Update oldest timestamp for next resurrect
      this.oldestWorkflowTimestamp = resurrectedWorkflow.createdAt

      // Combine current and resurrected workflows
      const allWorkflows = [...currentWorkflows, resurrectedWorkflow]

      // Update the dashboard
      this.render(allWorkflows)

      this.dashboard.log(
        `Resurrected workflow: ${resurrectedWorkflow.title || resurrectedWorkflow.pipeline}`,
        "info",
      )
    } catch (error) {
      this.dashboard.log(
        `Failed to resurrect workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
        "info",
      )
    }
  }

  stop(): void {
    clearInterval(this.prTimer)
    clearInterval(this.dockerTimer)
    this.prTimer = undefined
    this.dockerTimer = undefined
    this.clearRefreshSpinnerTimer()
    this.pollerClient?.close()
    this.dashboard.destroy()
  }
}

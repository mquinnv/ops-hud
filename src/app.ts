import { exec } from "child_process"
import { promisify } from "util"
import { ConfigManager } from "./config.js"
import { Dashboard } from "./dashboard.js"
import { DockerServiceManager } from "./docker-utils.js"
import {
  BuildkiteProvider,
  type BuildkiteProviderOptions,
  resolveBuildkiteToken,
} from "./providers/buildkite.js"
import { GitHubProvider } from "./providers/github.js"
import { applyIsFailing } from "./providers/github-map.js"
import type { CiProvider, ProviderDiagnostic, Scope } from "./providers/types.js"
import { rerunVerb, runNoun } from "./run-wording.js"
import { isActive, type RunStatus } from "./status.js"
import type { DockerServiceStatus, Job, PullRequest, Run } from "./types.js"

const execAsync = promisify(exec)

// A run created up to this long before ops-hud started still counts as having
// happened while it was watching: provider timestamps and the local clock can
// disagree by a few seconds.
const CLOCK_SKEW_GRACE_MS = 30_000

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
}

export class App {
  // Pull requests and repository listing are GitHub-only concerns that are not
  // on CiProvider, so the GitHub provider is also held by its concrete type.
  // Nothing on the CI path may reach through this field.
  private github: GitHubProvider
  private providers: CiProvider[]
  // True when AppDependencies.providers was supplied (the tests' seam). In
  // that case initialize() must never overwrite the injected list with one
  // built from config/flags. Recorded here, rather than inferred from array
  // contents, so an injected empty array or a single-provider list is just as
  // protected as any other.
  private readonly providersInjected: boolean
  private readonly buildkiteFactory: (options: BuildkiteProviderOptions) => CiProvider
  private dockerService: DockerServiceManager
  private configManager: ConfigManager
  private dashboard: Dashboard
  private refreshInterval?: NodeJS.Timeout
  private repositories: string[] = []
  private jobs: Map<string, Job[]> = new Map() // Keyed by Run.key
  private isRefreshing = false
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

    // Initial fetch
    await this.performRefresh(false)

    // Start auto-refresh
    this.startAutoRefresh()
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
    if (!args.noGithub) {
      providers.push(this.github)
    }
    if (!args.noBuildkite) {
      const buildkiteConfig = this.configManager.buildkite
      providers.push(
        this.buildkiteFactory({
          token: resolveBuildkiteToken(process.env, buildkiteConfig),
          org: args.bkOrg ?? buildkiteConfig.org,
          pipelines: args.pipelines ?? buildkiteConfig.pipelines,
        }),
      )
    }
    return providers
  }

  private setupEventHandlers(): void {
    // Handle manual refresh - but make sure it's only called explicitly
    this.dashboard.onRefresh(() => {
      this.performRefresh(true)
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
        // Force refresh to update the status
        await this.performRefresh(true)
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

          // Force refresh to update the status
          await this.performRefresh(true)
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
        await this.performRefresh(true)
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

        await this.performRefresh(true)
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
        await this.performRefresh(true)
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

  private currentScope(): Scope {
    return { repositories: this.repositories }
  }

  private async performRefresh(_isManual: boolean = false): Promise<void> {
    // Don't refresh if a modal is open
    if (this.dashboard.isModalOpen()) return

    if (this.isRefreshing) return
    this.isRefreshing = true

    // Show loading in status bar instead of blocking dialog
    this.dashboard.showLoadingInStatus()

    try {
      // Fetch recent runs from every configured provider
      const scope = this.currentScope()
      const results = await Promise.all(this.providers.map((provider) => provider.fetchRuns(scope)))

      const allRuns: Run[] = []
      const providerJobs = new Map<string, Job[]>()
      for (const result of results) {
        allRuns.push(...result.runs)
        // Providers that embed jobs in their run payloads save us a round trip.
        if (result.jobs) {
          for (const [key, jobs] of result.jobs) {
            providerJobs.set(key, jobs)
          }
        }
      }
      const diagnostics = results.flatMap((result) => result.diagnostics)
      if (this.buildkiteDisabled) {
        diagnostics.push({
          provider: "buildkite",
          level: "info",
          message: "Buildkite: disabled (--no-buildkite)",
        })
      }
      this.logChangedDiagnostics(diagnostics)
      allRuns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

      // Kept for the empty-state panel: a Buildkite misconfiguration on a
      // checkout with no GitHub Actions runs must not look like idle CI.
      this.lastDiagnostics = diagnostics

      // Fetch PRs if requested
      if (this.showPRs) {
        this.pullRequests = await this.github.getAllPullRequests(this.repositories)
      }

      // Fetch Docker services if requested
      if (this.showDocker) {
        this.dashboard.log(
          `Checking Docker services for repositories: ${this.repositories.join(", ")}`,
          "debug",
        )
        this.dockerServices = await this.dockerService.getAllDockerStatus(
          this.repositories,
          (msg) => this.dashboard.log(msg, "debug"),
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
      }

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

      // Track the oldest timestamp for resurrect, from the providers that can
      // page backwards only: an old Buildkite build in the merged list would
      // otherwise make resurrect ask GitHub for runs older than that, and
      // skip every GitHub run in between.
      const pagingRuns = results
        .filter((_, index) => this.providers[index]?.fetchOlderRuns !== undefined)
        .flatMap((result) => result.runs)
      if (pagingRuns.length > 0) {
        const oldest = pagingRuns.reduce((a, b) =>
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

      // Jobs a provider handed over with its runs (Buildkite) are kept for
      // every visible run, finished ones included — they cost nothing. Only
      // active runs are worth a separate fetch.
      const jobPromises = visibleRuns
        .filter((run) => providerJobs.has(run.key) || isActive(run.status))
        .map(async (run) => {
          const embedded = providerJobs.get(run.key)
          if (embedded) return { key: run.key, jobs: embedded }
          const provider = this.providerFor(run)
          const jobs = provider ? await provider.fetchJobs(run) : []
          return { key: run.key, jobs }
        })

      const jobResults = await Promise.all(jobPromises)

      // Update jobs map
      this.jobs.clear()
      jobResults.forEach(({ key, jobs }) => {
        this.jobs.set(key, jobs)
      })

      // A GitHub run that is still going but already has a failed job is
      // doomed; say so. Buildkite reports this itself (the build's `failing`
      // state, which the mapper already turned into isFailing) and that is
      // authoritative: deriving it from jobs would flag skipped or
      // soft-failed jobs as failures.
      const workflows = visibleRuns.map((run) =>
        run.provider === "github" ? applyIsFailing(run, this.jobs.get(run.key) ?? []) : run,
      )

      // Update dashboard - only pass PRs/Docker data when those features are enabled
      this.dashboard.updateWorkflows(
        workflows,
        this.jobs,
        this.showPRs ? this.pullRequests : undefined,
        this.showDocker ? this.dockerServices : undefined,
        this.lastDiagnostics,
      )
    } catch (error) {
      // Show error in dashboard
      this.dashboard.log(`Error refreshing: ${error}`, "error")
      this.dashboard.showError(`Failed to load workflows: ${error}`)
    } finally {
      this.isRefreshing = false
      // Stop the refresh animation
      this.dashboard.stopRefreshAnimation()
    }
  }

  /** Logs each diagnostic the previous refresh did not also produce. */
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

  private startAutoRefresh(): void {
    const interval = this.configManager.refreshInterval
    this.refreshInterval = setInterval(() => {
      // Auto-refresh (don't call through manual refresh handler)
      this.performRefresh(false)
    }, interval)
  }

  private stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = undefined
    }
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
    this.dashboard.updateWorkflows(
      filteredWorkflows,
      this.jobs,
      this.showPRs ? this.pullRequests : undefined,
      this.showDocker ? this.dockerServices : undefined,
      this.lastDiagnostics,
    )
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

      // Fetch one run older than our oldest timestamp from every provider that
      // can page backwards; those that cannot sit resurrect out.
      const scope = this.currentScope()
      const before = this.oldestWorkflowTimestamp
      const olderWorkflows: Run[] = []
      for (const provider of this.providers) {
        if (!provider.fetchOlderRuns) continue
        const result = await provider.fetchOlderRuns(scope, before, 1)
        olderWorkflows.push(...result.runs)
        for (const diagnostic of result.diagnostics) {
          this.dashboard.log(diagnostic.message, diagnostic.level === "error" ? "error" : "info")
        }
      }
      olderWorkflows.sort(
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
      this.dashboard.updateWorkflows(
        allWorkflows,
        this.jobs,
        this.showPRs ? this.pullRequests : undefined,
        this.showDocker ? this.dockerServices : undefined,
        this.lastDiagnostics,
      )

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
    this.stopAutoRefresh()
    this.dashboard.destroy()
  }
}

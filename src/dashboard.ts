import type { Duplex } from "node:stream"
import blessed from "blessed"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { PollerStatus } from "./poller/client.js"
import type { Budget } from "./poller/protocol.js"
import type { ProviderDiagnostic } from "./providers/types.js"
import { rerunVerb, runNoun } from "./run-wording.js"
import { isActive, isTerminal, statusColor, statusIcon } from "./status.js"
import type { DockerServiceStatus, Job, PullRequest, Run } from "./types.js"

/**
 * Makes API- or user-sourced text safe to interpolate into tagged blessed
 * content. blessed parses `{word}` as a tag, so a Buildkite command such as
 * `echo ${BUILDKITE_COMMIT}` would lose its variable name and a stray `{/}`
 * would reset colours. Always escape the raw text after any truncation, so a
 * cut can never land inside an `{open}`/`{close}` sequence.
 */
function esc(text: string | undefined | null): string {
  return text ? blessed.escape(text) : ""
}

/** Truncates raw text to `max` visible characters with an ellipsis, then escapes it. */
function escTruncated(text: string, max: number): string {
  if (max <= 0) return ""
  const cut = text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
  return esc(cut)
}

/**
 * Finished runs can be dismissed, and so can blocked ones: a pipeline that
 * blocks on a manual gate every run would otherwise pile up cards forever.
 * A dismissed blocked run comes back as soon as its status changes.
 */
function isDismissable(run: Run): boolean {
  return isTerminal(run.status) || run.status === "blocked"
}

/** The visible width of tagged content with no escaped braces in it. */
function visibleLength(tagged: string): number {
  return tagged.replace(/\{\/?[\w\-,;!#]*\}/g, "").length
}

/** Status-bar field for the GitHub rate-limit budget and poller mode; "" when idle. */
export function budgetSegment(
  budget: Budget | undefined,
  status: PollerStatus | undefined,
  now: number,
): string {
  const time = (ms: number): string =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  let text = ""
  if (budget && budget.limit > 0) {
    if (budget.pausedUntil !== undefined && budget.pausedUntil > now) {
      text = ` | {red-fg}GH paused until ${time(budget.pausedUntil)}{/red-fg}`
    } else if (budget.stretched) {
      text = ` | {yellow-fg}GH slow (budget low) ${budget.remaining}/${budget.limit}{/yellow-fg}`
    } else {
      text = ` | GH ${budget.remaining}/${budget.limit} · resets ${time(budget.resetAt)}`
    }
  }
  if (status?.mode === "in-process") text += " | poller: in-process"
  return text
}

export class Dashboard {
  private screen: blessed.Widgets.Screen
  private grid: blessed.Widgets.BoxElement[] = []
  private statusBox: blessed.Widgets.BoxElement
  private debugBox: blessed.Widgets.BoxElement
  private prHeaderBox?: blessed.Widgets.BoxElement
  private dockerHeaderBox?: blessed.Widgets.BoxElement
  private helpBox?: blessed.Widgets.BoxElement
  private confirmBox?: blessed.Widgets.BoxElement
  private selectedIndex = 0
  private selectedPRIndex = 0
  private selectedDockerIndex = 0
  private flatDockerServices: Array<{
    service: { name: string; state: string; health?: string }
    repo: string
    composeFile?: string
    isProject?: boolean // True if this represents the project name, not individual service
  }> = []
  private selectionMode: "workflows" | "prs" | "docker" = "workflows" // Track which area is selected
  private workflows: Run[] = []
  private pullRequests: PullRequest[] = []
  private dockerServices: DockerServiceStatus[] = []
  private jobsCache = new Map<string, Job[]>() // Cache for job data, keyed by Run.key
  private modalOpen = false
  private currentBoxWidth = 80
  private cols = 1 // Number of columns in the grid
  private rows = 1 // Number of rows in the grid
  private showPRs = false
  private showDocker = false
  private showDebug = false // Hidden by default, press F9 to show
  private autoShowDebug = false // Whether to show debug log on startup
  private logLevel: "info" | "debug" | "trace" = "info" // Filter level for event log
  private logMessages: Array<{
    message: string
    type: string
    timestamp: string
    formatted: string
  }> = []
  private maxLogMessages = 100 // Keep last 100 messages
  private debugBoxHeight = 5 // Default height, can be resized
  private minDebugHeight = 3
  private maxDebugHeight = 15
  private layoutInProgress = false
  private uiUpdateInProgress = false
  private keyEventQueue: Array<() => void> = []
  private pendingPrefsLog: string[] = [] // Store preference log messages until UI is ready
  private debugUpdateTimer?: NodeJS.Timeout // Timer for batched debug box updates
  private refreshAnimationTimer?: NodeJS.Timeout // Timer for refresh animation
  private refreshAnimationFrame = 0 // Current frame of refresh animation
  private lastRefreshTime?: Date // Track when data was actually refreshed
  private budget: Budget | undefined
  private pollerStatus: PollerStatus | undefined
  private lastStatusLine1 = "" // Cache last status line to avoid re-rendering
  private lastStatusLine2 = "" // Cache last status line to avoid re-rendering
  private expandedJobs: Set<string> = new Set() // Expanded jobs, by Job.key (collapsed is the default)
  private zoomedMode = false // Track if a workflow is zoomed to full screen
  private zoomedWorkflowIndex = 0 // Track which workflow is zoomed
  // Provider diagnostics from the most recent refresh — shown in the
  // empty-state panel (a Buildkite failure must not look like idle CI) and
  // never shown once the grid has cards.
  private diagnostics: ProviderDiagnostic[] = []

  constructor(streams?: { input: Duplex; output: Duplex }) {
    // Load saved preferences
    this.loadPreferences()

    // Override TERM environment variable to force a simpler terminal
    const originalTerm = process.env.TERM
    process.env.TERM = "xterm-color" // Use xterm-color which doesn't have Setulc

    this.screen = blessed.screen({
      smartCSR: true,
      title: "Ops HUD",
      fullUnicode: true,
      warnings: false,
      keys: true,
      vi: false,
      mouse: true, // Enable mouse support for scrolling
      // Production never passes `streams`, so this is process.stdin/stdout as
      // before. Tests pass a throwaway PassThrough pair so blessed never
      // touches the real terminal (never switches to the alternate screen).
      input: streams?.input ?? process.stdin,
      output: streams?.output ?? process.stdout,
      terminal: "xterm-color", // Force xterm-color to avoid Setulc
      forceUnicode: true,
      fastCSR: true, // Use fast CSR to reduce flickering
      useBCE: false, // Don't use background color erase which can cause flicker
      autoPadding: false, // Disable auto padding which can cause redraws
      ignoreDockContrast: true, // Avoid special terminal handling
      dockContrast: false, // Disable dock contrast which may trigger Setulc
    })

    // Restore original TERM after screen creation
    if (originalTerm) {
      process.env.TERM = originalTerm
    }

    // Create debug/log box (sits above status bar when shown)
    this.debugBox = blessed.box({
      bottom: 3,
      left: 0,
      width: "100%",
      height: this.debugBoxHeight,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "cyan",
        // bg removed - inherit terminal background
        border: {
          fg: "#888888",
        },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        track: {
          bg: "cyan",
        },
        style: {
          inverse: true,
        },
      },
      keys: true,
      vi: false, // Disable vi mode to prevent ESC from closing
      label: " Event Log (F9 to toggle) ",
      hidden: !this.showDebug,
    })

    // Create status bar at the bottom (2 lines of content + border)
    this.statusBox = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        // bg removed - inherit terminal background
        border: {
          fg: "#f0f0f0",
        },
      },
    })

    this.screen.append(this.debugBox)
    this.screen.append(this.statusBox)

    // Create help box (hidden initially)
    this.createHelpBox()

    // Set up key bindings
    this.setupKeyBindings()

    // Manual key handling as fallback for problematic keys
    this.screen.on("keypress", (_ch, key) => {
      if (!key) return

      // ESC key handling - exit zoom mode if zoomed, otherwise ignore
      if (key.name === "escape") {
        if (this.zoomedMode) {
          this.queueKeyEvent(() => {
            this.toggleZoomMode()
          })
        }
        return // Prevent any default handling
      }

      // Manual key handling for uppercase D as fallback
      if (key.name === "d" && key.shift && !key.ctrl && !key.meta) {
        const completedWorkflows = this.workflows.filter((w) => isTerminal(w.status))
        if (completedWorkflows.length > 0) {
          this.screen.emit("dismiss-all-completed", completedWorkflows)
        }
        return // Prevent further processing
      }

      // Handle lowercase d manually as additional backup
      if (key.name === "d" && !key.shift && !key.ctrl && !key.meta) {
        const workflow = this.workflows[this.selectedIndex]
        if (workflow && isDismissable(workflow)) {
          this.screen.emit("dismiss-workflow", workflow)
        }
      }
    })

    // Handle resize
    this.screen.on("resize", () => {
      this.layoutWorkflows()
      this.renderWorkflows(this.workflows, this.jobsCache)
      if (this.prHeaderBox) {
        const prContent = this.formatPRHeader(this.pullRequests)
        this.prHeaderBox.setContent(prContent)
      }
      if (this.dockerHeaderBox) {
        const dockerContent = this.formatDockerHeader(this.dockerServices)
        this.dockerHeaderBox.setContent(dockerContent)
      }
    })

    // Show initial status (no loading dialog)
    this.showInitialState()

    // Ensure screen can receive key events and render
    this.screen.render()

    // Make sure we're listening for the right key events
    this.screen.program.input.setEncoding("utf8")
    this.screen.program.input.resume()

    // Force the screen to grab keys and focus
    this.screen.enableKeys()

    // Hide cursor
    if (this.screen.program) {
      this.screen.program.hideCursor()

      // Remove Setulc capability entirely from terminfo
      const program = this.screen.program as {
        terminfo?: Record<string, unknown>
        terminal?: Record<string, unknown>
        tput?: Record<string, unknown>
        _write?: (text: string) => boolean | undefined
        write?: (text: string) => boolean | undefined
      }
      if (program.terminfo) {
        delete program.terminfo.Setulc
        delete program.terminfo.setulc
      }
      if (program.terminal) {
        delete program.terminal.Setulc
        delete program.terminal.setulc
      }
      // Also remove from the blessed tput if it exists
      if (program.tput) {
        delete program.tput.Setulc
        delete program.tput.setulc
      }

      // Wrap ALL program methods to catch terminal errors
      // Wrap the _write method which is what actually outputs
      const original_write = program._write?.bind(program) || program.write?.bind(program)
      if (original_write) {
        program._write = (text: string) => {
          try {
            return original_write(text)
          } catch (error: unknown) {
            // Silently ignore ALL terminal capability errors
            const errorMessage = error instanceof Error ? error.message : String(error)
            process.stderr.write(`\nIgnoring terminal error: ${errorMessage?.substring(0, 50)}\n`)
            return true
          }
        }
      }

      // Also wrap the main write method
      const originalWrite = program.write?.bind(program)
      if (originalWrite) {
        program.write = (text: string) => {
          try {
            return originalWrite(text)
          } catch (error: unknown) {
            // Silently ignore terminal capability errors
            const errorMessage = error instanceof Error ? error.message : String(error)
            process.stderr.write(`\nIgnoring write error: ${errorMessage?.substring(0, 50)}\n`)
            return true
          }
        }
      }
    }
  }

  private setupKeyBindings(): void {
    // Make sure the screen is focused and can receive key events
    // Note: blessed screens don't have a focus() method

    // Handle quit commands with proper cleanup
    this.screen.key(["q", "C-c"], () => {
      this.cleanup()
    })

    // Handle manual refresh
    this.screen.key(["r"], () => {
      this.screen.emit("manual-refresh")
    })

    // 2D Grid Navigation keys with seamless Docker/PR/workflow navigation
    this.screen.key(["up"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "workflows") {
          // If no workflows, try to move up to PRs or Docker
          if (this.workflows.length === 0) {
            if (this.showPRs && this.pullRequests.length > 0) {
              this.selectionMode = "prs"
              this.selectedPRIndex = 0
              this.updatePRHighlight()
              this.highlightSelected()
            } else if (this.showDocker && this.flatDockerServices.length > 0) {
              this.selectionMode = "docker"
              this.selectedDockerIndex = 0
              this.updateDockerHighlight()
              this.highlightSelected()
            }
            return
          }

          // If on top row of workflows, move to PRs or Docker
          const currentCoords = this.indexToCoords(this.selectedIndex)
          if (currentCoords.row === 0) {
            if (this.showPRs && this.pullRequests.length > 0) {
              this.selectionMode = "prs"
              // Select rightmost PR if coming from right column
              if (this.cols > 1 && currentCoords.col > 0) {
                this.selectedPRIndex = Math.min(currentCoords.col, this.pullRequests.length - 1)
              }
              this.updatePRHighlight()
              this.highlightSelected()
            } else if (this.showDocker && this.flatDockerServices.length > 0) {
              this.selectionMode = "docker"
              this.updateDockerHighlight()
              this.highlightSelected()
            }
          } else {
            this.navigateGrid("up")
          }
        } else if (this.selectionMode === "prs") {
          // First try to navigate within PRs
          const oldIndex = this.selectedPRIndex
          this.navigatePRs("up")

          // If we're still at the same index (reached top of PR list)
          // then try to move to Docker
          if (
            this.selectedPRIndex === oldIndex &&
            this.selectedPRIndex === 0 &&
            this.showDocker &&
            this.flatDockerServices.length > 0
          ) {
            this.selectionMode = "docker"
            this.updateDockerHighlight()
            this.updatePRHighlight()
          }
        } else if (this.selectionMode === "docker") {
          // Navigate within Docker services
          this.navigateDocker("left")
        }
      })
    })

    this.screen.key(["down"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "docker") {
          // Moving down from Docker goes to PRs or workflows
          if (this.showPRs && this.pullRequests.length > 0) {
            this.selectionMode = "prs"
            this.updateDockerHighlight()
            this.updatePRHighlight()
          } else if (this.workflows.length > 0) {
            this.selectionMode = "workflows"
            this.selectedIndex = 0
            this.updateDockerHighlight()
            this.highlightSelected()
          }
          // If no workflows available, stay in docker mode
        } else if (this.selectionMode === "prs") {
          // First try to navigate within PRs
          const oldIndex = this.selectedPRIndex
          this.navigatePRs("down")

          // If we're still at the same index (reached bottom of PR list)
          // then try to move to workflows
          if (
            this.selectedPRIndex === oldIndex &&
            this.selectedPRIndex === this.pullRequests.length - 1 &&
            this.workflows.length > 0
          ) {
            this.selectionMode = "workflows"
            // Try to position in the same column if possible
            const targetCol = Math.min(this.selectedPRIndex, this.cols - 1)
            const targetIndex = Math.min(targetCol, this.workflows.length - 1)
            this.selectedIndex = targetIndex
            this.updatePRHighlight()
            this.highlightSelected()
          }
        } else if (this.selectionMode === "workflows") {
          this.navigateGrid("down")
        }
      })
    })

    // Debug: catch all key events to see what's happening
    this.screen.on("keypress", (_ch: string | undefined, key: { name?: string }) => {
      if (key && (key.name === "left" || key.name === "right")) {
        this.log(
          `Key event detected: ${key.name}, mode: ${this.selectionMode}, modalOpen: ${this.modalOpen}`,
          "debug",
        )
      }
    })

    // Left/right navigation
    this.screen.key(["left"], () => {
      this.log(`Left key handler triggered, mode: ${this.selectionMode}`, "debug")
      this.queueKeyEvent(() => {
        this.log(`Left key pressed, mode: ${this.selectionMode}`, "debug")
        if (this.selectionMode === "workflows") {
          this.navigateGrid("left")
        } else if (this.selectionMode === "prs") {
          // PRs are vertical, left/right does nothing
          this.log(`PRs are vertical, ignoring left key`, "debug")
        } else if (this.selectionMode === "docker") {
          this.navigateDocker("left")
        }
      })
    })

    this.screen.key(["right"], () => {
      this.log(`Right key handler triggered, mode: ${this.selectionMode}`, "debug")
      this.queueKeyEvent(() => {
        this.log(`Right key pressed, mode: ${this.selectionMode}`, "debug")
        if (this.selectionMode === "workflows") {
          this.navigateGrid("right")
        } else if (this.selectionMode === "prs") {
          // PRs are vertical, left/right does nothing
          this.log(`PRs are vertical, ignoring right key`, "debug")
        } else if (this.selectionMode === "docker") {
          this.navigateDocker("right")
        }
      })
    })

    // Open workflow/PR in browser or restart Docker service
    this.screen.key(["enter"], () => {
      if (this.selectionMode === "workflows") {
        const workflow = this.workflows[this.selectedIndex]
        if (workflow) {
          this.screen.emit("open-workflow", workflow)
        }
      } else if (this.selectionMode === "prs" && this.showPRs) {
        const pr = this.pullRequests[this.selectedPRIndex]
        if (pr) {
          this.screen.emit("open-pr", pr)
        }
      } else if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex]
        if (dockerService) {
          if (dockerService.isProject) {
            this.screen.emit("docker-action", "up", dockerService)
          } else {
            this.screen.emit("docker-action", "restart", dockerService)
          }
        }
      }
    })

    // Docker-specific keybindings
    this.screen.key(["s"], () => {
      if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex]
        if (dockerService) {
          if (dockerService.isProject) {
            this.screen.emit("docker-action", "start-all", dockerService)
          } else {
            // Smart toggle: stop if running, start if stopped
            const action = dockerService.service.state === "running" ? "stop" : "start"
            this.screen.emit("docker-action", action, dockerService)
          }
        }
      }
    })

    // Docker project-level stop all command
    this.screen.key(["t"], () => {
      if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex]
        if (dockerService?.isProject) {
          this.screen.emit("docker-action", "stop-all", dockerService)
        }
      }
    })

    // Docker project-level down command
    this.screen.key(["d"], () => {
      if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex]
        if (dockerService?.isProject) {
          this.screen.emit("docker-action", "down", dockerService)
        }
      } else if (this.selectionMode === "workflows") {
        // Keep existing workflow dismiss functionality
        const workflow = this.workflows[this.selectedIndex]
        if (workflow && isDismissable(workflow)) {
          this.screen.emit("dismiss-workflow", workflow)
        }
      }
    })

    this.screen.key(["l"], () => {
      if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex]
        if (dockerService) {
          const action = dockerService.isProject ? "logs-all" : "logs"
          this.screen.emit("docker-action", action, dockerService)
        }
      } else if (this.selectionMode === "workflows") {
        const workflow = this.workflows[this.selectedIndex]
        if (workflow) {
          this.screen.emit("workflow-logs", workflow)
        }
      }
    })

    this.screen.key(["u"], () => {
      if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex]
        if (dockerService) {
          this.screen.emit("docker-action", "recreate", dockerService)
        }
      }
    })

    this.screen.key(["x"], () => {
      if (this.selectionMode === "docker" && this.showDocker) {
        const dockerService = this.flatDockerServices[this.selectedDockerIndex]
        if (dockerService) {
          this.screen.emit("docker-action", "shell", dockerService)
        }
      }
    })

    // PR-specific keybindings
    this.screen.key(["m"], () => {
      if (this.selectionMode === "prs" && this.showPRs) {
        const pr = this.pullRequests[this.selectedPRIndex]
        if (pr && pr.mergeable === "MERGEABLE") {
          this.showMergeMenu(pr)
        }
      }
    })

    this.screen.key(["c"], () => {
      if (this.selectionMode === "prs" && this.showPRs) {
        const pr = this.pullRequests[this.selectedPRIndex]
        if (pr) {
          this.screen.emit("pr-checkout", pr)
        }
      }
    })

    this.screen.key(["r"], () => {
      if (this.selectionMode === "prs" && this.showPRs) {
        const pr = this.pullRequests[this.selectedPRIndex]
        if (pr) {
          const action = pr.isDraft ? "ready" : "draft"
          this.screen.emit("pr-action", action, pr)
        }
      } else if (this.selectionMode === "workflows") {
        const workflow = this.workflows[this.selectedIndex]
        if (workflow && isTerminal(workflow.status)) {
          this.screen.emit("workflow-rerun", workflow)
        }
      } else {
        // Regular refresh for other modes
        this.screen.emit("manual-refresh")
      }
    })

    // Dismiss completed workflow
    this.screen.key(["d"], () => {
      const workflow = this.workflows[this.selectedIndex]
      if (workflow && isDismissable(workflow)) {
        this.screen.emit("dismiss-workflow", workflow)
      }
    })

    // Kill/cancel running workflow
    this.screen.key(["k"], () => {
      const workflow = this.workflows[this.selectedIndex]
      if (workflow && isActive(workflow.status)) {
        this.showKillConfirmation(workflow)
      }
    })

    // Dismiss ALL completed workflows - comprehensive key handling
    const dismissAllHandler = () => {
      const completedWorkflows = this.workflows.filter((w) => isTerminal(w.status))
      if (completedWorkflows.length > 0) {
        this.screen.emit("dismiss-all-completed", completedWorkflows)
      }
    }

    // Try multiple key binding approaches
    this.screen.key(["D"], dismissAllHandler)
    this.screen.key(["S-d"], dismissAllHandler)
    this.screen.key(["shift+d"], dismissAllHandler)

    // Resurrect older workflow
    this.screen.key(["U"], () => {
      this.queueKeyEvent(() => {
        this.screen.emit("resurrect-workflow")
      })
    })

    // Toggle job step collapse
    this.screen.key(["j"], () => {
      this.queueKeyEvent(() => {
        this.toggleJobStepsCollapse()
      })
    })

    // Toggle zoom mode for selected workflow
    this.screen.key(["z"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "workflows" && this.workflows.length > 0) {
          this.toggleZoomMode()
        }
      })
    })

    // Scroll within workflow box
    this.screen.key(["pageup"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "workflows" && this.grid.length > 0) {
          const box = this.grid[this.zoomedMode ? 0 : this.selectedIndex]
          if (box) {
            box.scroll(-5) // Scroll up 5 lines
            this.screen.render()
          }
        }
      })
    })

    this.screen.key(["pagedown"], () => {
      this.queueKeyEvent(() => {
        if (this.selectionMode === "workflows" && this.grid.length > 0) {
          const box = this.grid[this.zoomedMode ? 0 : this.selectedIndex]
          if (box) {
            box.scroll(5) // Scroll down 5 lines
            this.screen.render()
          }
        }
      })
    })

    // Show help - don't use queue, just show directly
    this.screen.key(["?", "/"], () => {
      // Removed debug output
      this.showHelp()
    })

    // Toggle debug panel - F9 only, no F12 to avoid conflicts
    this.screen.key(["f9"], () => {
      this.queueKeyEvent(() => this.toggleDebug())
    })

    // Toggle log level (F10)
    this.screen.key(["f10"], () => {
      this.queueKeyEvent(() => this.toggleLogLevel())
    })

    // Toggle auto-show on startup (a for auto-show)
    this.screen.key(["a", "A"], () => {
      this.queueKeyEvent(() => this.toggleAutoShowDebug())
    })

    // Resize debug panel (when visible) - vim-style
    this.screen.key(["C-k"], () => {
      this.queueKeyEvent(() => {
        if (this.showDebug) {
          this.resizeDebugBox(1) // Increase height (up = more lines)
        }
      })
    })

    // Ctrl+j might be interpreted as newline in some terminals, so we need multiple bindings
    const decreaseDebugHandler = () => {
      this.queueKeyEvent(() => {
        if (this.showDebug) {
          this.resizeDebugBox(-1) // Decrease height (down = fewer lines)
        }
      })
    }

    this.screen.key(["C-j"], decreaseDebugHandler)
    this.screen.key(["ctrl+j"], decreaseDebugHandler)
    // Alternative keys for decreasing debug box size
    this.screen.key(["C-d"], decreaseDebugHandler)
    this.screen.key(["M-j"], decreaseDebugHandler) // Alt+j as alternative

    // Also handle process signals for clean shutdown
    process.on("SIGINT", () => {
      this.log("Received SIGINT, saving preferences...", "info")
      this.cleanup()
    })
    process.on("SIGTERM", () => {
      this.log("Received SIGTERM, saving preferences...", "info")
      this.cleanup()
    })
    // Handle uncaught exits
    process.on("beforeExit", () => {
      this.log("Process exiting, saving preferences...", "info")
      this.savePreferences()
    })
  }

  // Convert linear array index to 2D grid coordinates
  private indexToCoords(index: number): { row: number; col: number } {
    // Ensure cols is at least 1 to avoid division by zero
    const cols = Math.max(1, this.cols)
    return {
      row: Math.floor(index / cols),
      col: index % cols,
    }
  }

  // Convert 2D grid coordinates to linear array index
  private coordsToIndex(row: number, col: number): number {
    return row * this.cols + col
  }

  // Check if a grid position is valid (within bounds and has a workflow)
  private isValidGridPosition(row: number, col: number): boolean {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      return false
    }
    const index = this.coordsToIndex(row, col)
    return index >= 0 && index < this.workflows.length
  }

  // Navigate PRs - handle vertical navigation since PRs are displayed as a vertical list
  private navigatePRs(direction: "up" | "down" | "left" | "right"): void {
    if (this.pullRequests.length === 0) return

    const currentIndex = this.selectedPRIndex
    let newIndex = currentIndex

    switch (direction) {
      case "up":
        newIndex = currentIndex - 1
        if (newIndex < 0) {
          // At top of PR list, let the up handler switch to Docker section
          return
        }
        break
      case "down":
        newIndex = currentIndex + 1
        if (newIndex >= this.pullRequests.length) {
          // At bottom of PR list, could switch to workflows if they exist
          return
        }
        break
      case "left":
      case "right":
        // Left/right do nothing in vertical PR list
        return
    }

    if (newIndex !== currentIndex) {
      this.log(
        `PR navigation: ${currentIndex} -> ${newIndex} (of ${this.pullRequests.length})`,
        "debug",
      )
      this.selectedPRIndex = newIndex
      this.updatePRHighlight()
    }
  }

  // Navigate Docker services
  private navigateDocker(direction: "up" | "down" | "left" | "right"): void {
    if (this.flatDockerServices.length === 0) return

    const currentIndex = this.selectedDockerIndex
    let newIndex = currentIndex

    switch (direction) {
      case "left":
      case "up":
        newIndex = currentIndex - 1
        if (newIndex < 0) {
          newIndex = this.flatDockerServices.length - 1 // Wrap to end
        }
        break
      case "right":
      case "down":
        newIndex = currentIndex + 1
        if (newIndex >= this.flatDockerServices.length) {
          newIndex = 0 // Wrap to beginning
        }
        break
    }

    if (newIndex !== currentIndex) {
      this.selectedDockerIndex = newIndex
      this.updateDockerHighlight()
    }
  }

  // Update PR header to show selection
  private updatePRHighlight(): void {
    if (!this.prHeaderBox) return

    // Re-render PR content with selection highlight
    const prContent = this.formatPRHeader(this.pullRequests)
    this.prHeaderBox.setContent(prContent)

    // Update border color based on selection mode
    if (this.prHeaderBox.style?.border) {
      this.prHeaderBox.style.border.fg = this.selectionMode === "prs" ? "cyan" : "#f0f0f0"
    }

    this.scheduleRender()
  }

  // Update Docker header to show selection
  private updateDockerHighlight(): void {
    if (!this.dockerHeaderBox) return

    // Re-render Docker content with selection highlight
    const dockerContent = this.formatDockerHeader(this.dockerServices)
    this.dockerHeaderBox.setContent(dockerContent)

    // Update border color based on selection mode
    if (this.dockerHeaderBox.style?.border) {
      this.dockerHeaderBox.style.border.fg = this.selectionMode === "docker" ? "cyan" : "#888888"
    }

    this.scheduleRender()
  }

  // Navigate the 2D grid spatially
  private navigateGrid(direction: "up" | "down" | "left" | "right"): void {
    try {
      // Don't navigate if no workflows or grid not ready
      if (this.workflows.length === 0 || this.grid.length === 0) return

      // Check if layout is somehow being triggered
      if (this.layoutInProgress) {
        return // Don't navigate during layout
      }

      // Ensure cols and rows are initialized
      if (!this.cols || !this.rows) {
        this.cols = 1
        this.rows = 1
      }

      // Ensure selectedIndex is valid
      if (this.selectedIndex >= this.workflows.length || this.selectedIndex < 0) {
        this.selectedIndex = 0
      }

      const currentCoords = this.indexToCoords(this.selectedIndex)
      let newRow = currentCoords.row
      let newCol = currentCoords.col

      switch (direction) {
        case "up":
          newRow = currentCoords.row - 1
          // If at top row, don't wrap - stay in place
          // PR navigation is handled in the keybinding, not here
          if (newRow < 0) {
            return
          }
          break

        case "down":
          newRow = currentCoords.row + 1
          // If at bottom row, don't wrap - stay in place
          if (newRow >= this.rows) {
            return
          }
          break

        case "left":
          // If only one column, can't move left
          if (this.cols <= 1) {
            return
          }
          newCol = currentCoords.col - 1
          // If at leftmost column, don't wrap - stay in place
          if (newCol < 0) {
            return
          }
          break

        case "right":
          // If only one column, can't move right
          if (this.cols <= 1) {
            return
          }
          newCol = currentCoords.col + 1
          // If at rightmost column, don't wrap - stay in place
          if (newCol >= this.cols) {
            return
          }
          break
      }

      // Check if the new position is valid (has a workflow)
      if (this.isValidGridPosition(newRow, newCol)) {
        const newIndex = this.coordsToIndex(newRow, newCol)
        if (newIndex < this.workflows.length) {
          this.selectedIndex = newIndex
          this.highlightSelected()
        }
      }
      // If invalid position (like last row with fewer items), don't move
    } catch (error) {
      // Log the error but don't crash
      this.log(`Navigation error: ${error}`, "error")

      // Write to stderr so we can see it even if the UI crashes
      process.stderr.write(`\nNavigation error: ${error}\n`)
    }
  }

  private getBorderColor(run: Run, isSelected: boolean): string {
    if (isSelected) return "cyan" // Selected always gets cyan border

    if (isTerminal(run.status)) {
      switch (run.status) {
        case "passed":
          return "green"
        case "failed":
        case "timed_out":
        case "canceled":
          return "red"
        case "skipped":
          return "#888888"
        default:
          return "#f0f0f0"
      }
    }

    return "#f0f0f0" // Default border for active runs
  }

  private lastSelectedIndex = -1

  private highlightSelected(): void {
    // Don't highlight if grid is not ready
    if (!this.grid || this.grid.length === 0) return

    // Ensure selectedIndex is valid
    const maxIndex = Math.min(this.grid.length, this.workflows.length) - 1
    if (this.selectedIndex > maxIndex) {
      this.selectedIndex = Math.max(0, maxIndex)
    }

    // Skip if selection hasn't changed and we're in workflow mode
    if (this.selectedIndex === this.lastSelectedIndex && this.selectionMode === "workflows") {
      return
    }

    // Clear workflow selection if we're not in workflow mode
    if (this.selectionMode !== "workflows") {
      // Remove highlight from all workflow boxes
      this.grid.forEach((box, index) => {
        if (box?.style?.border) {
          const workflow = this.workflows[index]
          box.style.border.fg = workflow ? this.getBorderColor(workflow, false) : "#f0f0f0"
        }
      })
      this.lastSelectedIndex = -1
      this.scheduleRender()
      return
    }

    try {
      // Only update the two boxes that changed (old selected and new selected)
      if (this.lastSelectedIndex >= 0 && this.lastSelectedIndex < this.grid.length) {
        const oldBox = this.grid[this.lastSelectedIndex]
        if (oldBox?.style?.border) {
          const workflow = this.workflows[this.lastSelectedIndex]
          oldBox.style.border.fg = workflow ? this.getBorderColor(workflow, false) : "#f0f0f0"
        }

        // Update old box content to remove selected header styling
        const oldWorkflow = this.workflows[this.lastSelectedIndex]
        if (oldWorkflow) {
          const jobs = this.jobsCache.get(oldWorkflow.key) || []
          const oldContent = this.formatWorkflowContent(oldWorkflow, jobs, false)
          oldBox.setContent(oldContent)
        }
      }

      // Update new selected box
      if (this.selectedIndex >= 0 && this.selectedIndex < this.grid.length) {
        const newBox = this.grid[this.selectedIndex]
        if (newBox?.style?.border) {
          newBox.style.border.fg = "cyan"
        }

        // Update new box content to show selected header styling
        const newWorkflow = this.workflows[this.selectedIndex]
        if (newWorkflow) {
          const jobs = this.jobsCache.get(newWorkflow.key) || []
          const newContent = this.formatWorkflowContent(newWorkflow, jobs, true)
          newBox.setContent(newContent)
        }
      }

      this.lastSelectedIndex = this.selectedIndex

      // Use batched render to avoid flickering
      this.scheduleRender()
    } catch (error) {
      this.log(`Error in highlightSelected: ${error}`, "error")
    }
  }

  // Removed screen click handler as it was causing issues with mouse hover

  private createHelpBox(): void {
    // Remove old help box if it exists
    if (this.helpBox) {
      this.helpBox.destroy()
    }

    this.helpBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "50%",
      height: "50%",
      content: `
{center}{bold}Ops HUD - Help{/bold}{/center}

{bold}Navigation:{/bold}
  Tab        - Switch between PRs and workflows
  ↑/k        - Move up in current area
  ↓/j        - Move down in current area
  ←/h        - Move left in current area
  →/l        - Move right in current area
  PgUp/PgDn  - Scroll within workflow box
  Enter      - Open selected item in browser

{bold}Actions:{/bold}
  r       - Force refresh
  d       - Dismiss finished run (blocked: until it changes)
  D       - Dismiss ALL completed runs
  k       - Kill/cancel running run
  j       - Expand/collapse job steps (completed jobs are collapsed by default)
  U       - Resurrect older run (undo dismiss)
  ?       - Show this help
  q/Ctrl+C - Quit

{bold}Options:{/bold}
  --show-prs - Show open PRs in header
  F9         - Toggle event log panel
  F10        - Cycle log level (info/debug/trace)
  a          - Toggle auto-show on startup
  Ctrl+k/d   - Resize event log (when visible)

{bold}Status Colors:{/bold}
  {yellow-fg}●{/} Running
  {green-fg}●{/} Success
  {red-fg}●{/} Failed
  {#888888-fg}●{/} Queued

Press '?', '/', or 'Esc' to close...`,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "cyan",
        },
      },
      keys: true,
      hidden: true, // Start hidden
      focusable: false, // Don't steal focus when hidden
    })

    // Make sure help box is on top
    this.helpBox.setFront()

    // Set up help box key handlers once
    this.helpBox.key(["escape", "?", "/"], () => {
      this.hideHelp()
    })
  }

  private showHelp(): void {
    // Don't check isUpdating - we want help to always work

    // If already showing, hide it
    if (this.modalOpen && this.helpBox && !this.helpBox.hidden) {
      this.hideHelp()
      return
    }

    // Make sure help box exists
    if (!this.helpBox) {
      this.createHelpBox()
    }

    this.modalOpen = true
    if (this.helpBox) {
      this.helpBox.focusable = true // Make focusable when showing
      this.helpBox.show()
      this.helpBox.setFront() // Ensure it's on top
      this.helpBox.focus()

      // Force a render to show the help, catching any errors
      try {
        this.screen.render()
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        process.stderr.write(`\nHelp render error: ${errorMessage?.substring(0, 100)}\n`)

        // Try to at least make it visible
        try {
          this.helpBox.setFront()
          this.screen.render()
        } catch (_e) {
          process.stderr.write(`\nCritical help render failure\n`)
        }
      }
    }
  }

  private hideHelp(): void {
    this.modalOpen = false
    if (this.helpBox) {
      this.helpBox.hide()
      this.helpBox.focusable = false // Make non-focusable when hidden

      // Try a safe render
      try {
        this.scheduleRender()
      } catch (_error: unknown) {
        // Ignore render errors when closing help
        process.stderr.write(`\nIgnoring help close render error\n`)
      }
    }
  }

  private showKillConfirmation(run: Run): void {
    // Create confirmation dialog
    if (this.confirmBox) {
      this.confirmBox.destroy()
    }

    const projectName = run.repo.fullName
    const noun = runNoun(run)
    const titleNoun = noun.replace(/\b\w/g, (c) => c.toUpperCase())

    this.confirmBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: 60,
      height: 10,
      content: `{center}{bold}{red-fg}Cancel ${titleNoun}?{/red-fg}{/bold}{/center}

{center}${esc(projectName)}{/center}
{center}${esc(run.pipeline) || titleNoun} ${noun} #${run.number}{/center}
{center}Branch: ${esc(run.branch)}{/center}

{center}{bold}Press 'y' to confirm, 'n' or ESC to cancel{/bold}{/center}`,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "red",
        },
      },
      keys: true,
    })

    this.modalOpen = true
    this.confirmBox.show()
    this.confirmBox.setFront()
    this.confirmBox.focus()

    // Handle confirmation
    const confirmHandler = (_ch: string | undefined, key: { name?: string }) => {
      if (key && (key.name === "y" || key.name === "Y")) {
        // User confirmed
        this.hideKillConfirmation()
        this.screen.emit("kill-workflow", run)
      } else if (key && (key.name === "n" || key.name === "N" || key.name === "escape")) {
        // User cancelled
        this.hideKillConfirmation()
      }
    }

    this.confirmBox.once("keypress", confirmHandler)

    this.screen.render()
  }

  private hideKillConfirmation(): void {
    this.modalOpen = false
    if (this.confirmBox) {
      this.confirmBox.destroy()
      this.confirmBox = undefined
    }
    this.scheduleRender()
  }

  private mergeMenuBox?: blessed.Widgets.BoxElement

  private showMergeMenu(pr: PullRequest): void {
    // Create merge menu dialog
    if (this.mergeMenuBox) {
      this.mergeMenuBox.destroy()
    }

    const projectName = `${pr.repository.owner}/${pr.repository.name}`

    this.mergeMenuBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: 50,
      height: 12,
      content: `{center}{bold}{green-fg}Merge PR #${pr.number}{/green-fg}{/bold}{/center}\n\n{center}${pr.title}{/center}\n{center}${projectName}{/center}\n\n m: Merge commit\n s: Squash and merge\n r: Rebase and merge\n\n{center}{bold}ESC to cancel{/bold}{/center}`,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        border: {
          fg: "green",
        },
      },
      keys: true,
    })

    this.modalOpen = true
    this.mergeMenuBox.show()
    this.mergeMenuBox.setFront()
    this.mergeMenuBox.focus()

    // Handle merge options
    const mergeHandler = (_ch: string | undefined, key: { name?: string }) => {
      if (key) {
        if (key.name === "m") {
          this.hideMergeMenu()
          this.screen.emit("pr-merge", pr, "merge")
        } else if (key.name === "s") {
          this.hideMergeMenu()
          this.screen.emit("pr-merge", pr, "squash")
        } else if (key.name === "r") {
          this.hideMergeMenu()
          this.screen.emit("pr-merge", pr, "rebase")
        } else if (key.name === "escape") {
          this.hideMergeMenu()
        }
      }
    }

    this.mergeMenuBox.once("keypress", mergeHandler)

    this.screen.render()
  }

  private hideMergeMenu(): void {
    this.modalOpen = false
    if (this.mergeMenuBox) {
      this.mergeMenuBox.destroy()
      this.mergeMenuBox = undefined
    }
    this.scheduleRender()
  }

  private showInitialState(): void {
    // Just show the status bar with loading message - no intrusive dialog
    this.statusBox.setContent("{center}Loading workflows... Press 'q' to quit{/center}")
    this.log("Ops HUD started", "info")

    // Log any pending preference messages
    if (this.pendingPrefsLog.length > 0) {
      this.pendingPrefsLog.forEach((msg) => {
        this.log(msg, "debug")
      })
      this.pendingPrefsLog = []
    }

    this.log("Press F9 to toggle event log, Ctrl+k/d to resize, 'a' for auto-show", "info")

    if (this.autoShowDebug) {
      this.log("Event log auto-show is ON - will show on startup", "info")
    }

    // Update the debug box content if it's visible
    if (this.showDebug) {
      this.updateDebugBox()
    }

    this.screen.render()
  }

  updateWorkflows(
    workflows: Run[],
    jobs: Map<string, Job[]>,
    pullRequests?: PullRequest[],
    dockerServices?: DockerServiceStatus[],
    diagnostics?: ProviderDiagnostic[],
  ): void {
    // Don't update the display if a modal dialog is open
    if (this.modalOpen) {
      // Still update the data but don't re-render the screen
      this.workflows = workflows
      this.pullRequests = pullRequests || []
      this.dockerServices = dockerServices || []
      this.jobsCache = jobs // Update the cache
      this.diagnostics = diagnostics ?? []
      return
    }

    // Set update flag to prevent key events during update
    this.uiUpdateInProgress = true

    try {
      // Track changes before updating
      this.trackWorkflowChanges(workflows)

      const previousWorkflowCount = this.workflows.length
      this.workflows = workflows
      this.pullRequests = pullRequests || []
      this.dockerServices = dockerServices || []
      this.showPRs = pullRequests !== undefined
      this.showDocker = dockerServices !== undefined
      this.jobsCache = jobs // Update the cache
      this.diagnostics = diagnostics ?? []

      // Update debug info - now logged at trace level
      this.updateDebugInfo({
        showPRs: this.showPRs,
        prCount: this.pullRequests.length,
        workflowCount: this.workflows.length,
        jobsLoaded: jobs.size,
        lastUpdate: new Date().toLocaleTimeString(),
      })

      // Only show PR header when monitoring PRs AND there are PRs to display
      const hasPRs = this.showPRs && this.pullRequests.length > 0
      if (hasPRs && this.prHeaderBox) {
        // Just update content without recreating the box
        const prContent = this.formatPRHeader(this.pullRequests)
        this.prHeaderBox.setContent(prContent)
      } else if (hasPRs && !this.prHeaderBox) {
        this.createOrUpdatePRHeader()
      } else if (!hasPRs && this.prHeaderBox) {
        // Remove PR header when there are no PRs
        this.prHeaderBox.destroy()
        this.prHeaderBox = undefined
      }

      // Only show Docker header when monitoring Docker AND there are services to display
      const hasDocker = this.showDocker && this.dockerServices.length > 0
      if (hasDocker && this.dockerHeaderBox) {
        // Just update content without recreating the box
        const dockerContent = this.formatDockerHeader(this.dockerServices)
        this.dockerHeaderBox.setContent(dockerContent)
      } else if (hasDocker && !this.dockerHeaderBox) {
        this.createOrUpdateDockerHeader()
      } else if (!hasDocker && this.dockerHeaderBox) {
        // Remove Docker header when there are no services
        this.dockerHeaderBox.destroy()
        this.dockerHeaderBox = undefined
      }

      // Only recreate layout if the number of workflows changed or grid doesn't exist.
      // An empty grid is always rebuilt: diagnostics can change every refresh
      // (e.g. a Buildkite token starts failing) while the workflow count stays
      // at zero, and the empty-state panel must reflect the latest ones.
      if (
        workflows.length !== previousWorkflowCount ||
        this.grid.length === 0 ||
        workflows.length === 0
      ) {
        this.layoutWorkflows()
      }

      // Set appropriate initial selection mode based on what's available
      this.setInitialSelectionMode()

      // Always update content
      this.renderWorkflows(workflows, jobs)
    } finally {
      this.uiUpdateInProgress = false
      // Stop refresh animation
      this.stopRefreshAnimation()
      // Process any key events that were queued during the update
      this.processQueuedKeyEvents()
    }
  }

  getCurrentWorkflows(): Run[] {
    return this.workflows
  }

  private setInitialSelectionMode(): void {
    // Don't change mode if we're already in a valid state
    if (this.selectionMode === "workflows" && this.workflows.length > 0) return
    if (this.selectionMode === "prs" && this.showPRs && this.pullRequests.length > 0) return
    if (this.selectionMode === "docker" && this.showDocker && this.flatDockerServices.length > 0)
      return

    // Priority order: Docker > PRs > Workflows
    // This way we start with the most "static" content at the top
    if (this.showDocker && this.flatDockerServices.length > 0) {
      this.selectionMode = "docker"
      this.selectedDockerIndex = 0
    } else if (this.showPRs && this.pullRequests.length > 0) {
      this.selectionMode = "prs"
      this.selectedPRIndex = 0
    } else if (this.workflows.length > 0) {
      this.selectionMode = "workflows"
      this.selectedIndex = 0
    }
    // If nothing is available, stay in workflows mode but selectedIndex will be -1
  }

  isModalOpen(): boolean {
    return this.modalOpen
  }

  isUpdating(): boolean {
    return this.uiUpdateInProgress || this.layoutInProgress
  }

  private renderTimer?: NodeJS.Immediate

  private scheduleRender(): void {
    // Cancel any pending render
    if (this.renderTimer) {
      clearImmediate(this.renderTimer)
    }

    // Schedule render on next tick to batch updates
    this.renderTimer = setImmediate(() => {
      if (this.screen) {
        try {
          // Use render() without clearing - blessed handles differential updates
          this.screen.render()
        } catch (error: unknown) {
          // Catch and log render errors but don't crash
          const errorMessage = error instanceof Error ? error.message : String(error)
          process.stderr.write(`\nRender error: ${errorMessage?.substring(0, 100)}\n`)
        }
      }
      this.renderTimer = undefined
    })
  }

  private queueKeyEvent(handler: () => void): void {
    try {
      handler()
    } catch (error) {
      // Don't log here as it causes renders
      process.stderr.write(`\nKey handler error: ${error}\n`)
    }
  }

  private processQueuedKeyEvents(): void {
    // Process all queued events
    while (this.keyEventQueue.length > 0) {
      const handler = this.keyEventQueue.shift()
      if (handler) {
        try {
          handler()
        } catch (error) {
          this.log(`Error processing queued key event: ${error}`, "error")
        }
      }
    }
  }

  private toggleLogLevel(): void {
    // Cycle through log levels: info -> debug -> trace -> info
    if (this.logLevel === "info") {
      this.logLevel = "debug"
    } else if (this.logLevel === "debug") {
      this.logLevel = "trace"
    } else {
      this.logLevel = "info"
    }

    // Save the preference
    this.savePreferences()

    // Log the change
    this.log(`Log level: ${this.logLevel} (F10 to cycle)`, "info")

    // Update the debug box to reflect the filter change
    if (this.showDebug) {
      this.updateDebugBox()
    }
  }

  private layoutWorkflows(): void {
    // Prevent recursive layout calls
    if (this.layoutInProgress) return
    this.layoutInProgress = true

    // Layout is being called - this should only happen on refresh, not on key presses

    try {
      // Build new grid before destroying old one (double-buffering)
      const newGrid: blessed.Widgets.BoxElement[] = []

      // Calculate available height (account for status bar, debug box, PR header, and Docker header if shown)
      const debugHeight = this.showDebug ? this.debugBoxHeight : 0
      const prHeaderHeight = this.prHeaderBox ? 5 : 0
      const dockerHeaderHeight = this.dockerHeaderBox ? 5 : 0
      const screenHeight =
        (this.screen.height as number) - 4 - debugHeight - prHeaderHeight - dockerHeaderHeight // Status bar is now 4 high
      const screenWidth = this.screen.width as number
      const count = this.workflows.length
      const topOffset = prHeaderHeight + dockerHeaderHeight // Offset for PR and Docker headers

      if (count === 0) {
        // Show empty state, plus why each provider contributed nothing — a
        // Buildkite misconfiguration on a checkout with no GitHub Actions
        // runs must not look like idle CI. Error diagnostics render in red,
        // matching the event log's convention, so a rejected token is loud.
        const diagnosticsBlock =
          this.diagnostics.length > 0
            ? `\n\n${this.diagnostics
                .map((d) => {
                  const color = d.level === "error" ? "red-fg" : "white-fg"
                  return `{center}{${color}}${esc(d.message)}{/${color}}{/center}`
                })
                .join("\n")}`
            : ""

        const emptyBox = blessed.box({
          parent: this.screen,
          top: topOffset,
          left: 0,
          width: "100%",
          height: screenHeight,
          content: `{center}No running workflows found{/center}

{center}Monitoring for in-progress and queued workflows...{/center}
{center}Press 'r' to refresh or 'q' to quit{/center}

{center}Completed workflows will be shown until dismissed{/center}
{center}To see activity, trigger a workflow in your repositories{/center}${diagnosticsBlock}`,
          tags: true,
          border: {
            type: "line",
          },
          style: {
            fg: "#888888",
            border: {
              fg: "#f0f0f0",
            },
          },
        })
        newGrid.push(emptyBox)

        // Now swap grids atomically
        this.grid.forEach((box) => {
          box.destroy()
        })
        this.grid = newGrid
        return
      }

      // Handle zoom mode - show single workflow full screen
      if (this.zoomedMode) {
        // Use the zoomed workflow index
        const workflow = this.workflows[this.zoomedWorkflowIndex]
        if (workflow) {
          const borderColor = this.getBorderColor(workflow, true)

          const box = blessed.box({
            parent: this.screen,
            top: 0, // Use full vertical space (no PR/Docker headers in zoom mode)
            left: 0,
            width: "100%",
            height: (this.screen.height as number) - 4 - debugHeight, // Full height minus status bar and debug
            tags: true,
            border: {
              type: "line",
            },
            style: {
              fg: "white",
              border: {
                fg: borderColor,
              },
            },
            scrollable: true,
            alwaysScroll: true,
            keys: true,
            vi: false,
          })

          newGrid.push(box)

          // Store box width for formatting
          this.currentBoxWidth = screenWidth
          this.cols = 1
          this.rows = 1

          // Now swap grids atomically
          const oldGrid = this.grid
          this.grid = newGrid

          // Ensure selection highlighting is applied after creating the box
          this.highlightSelected()

          // Destroy old boxes after new one is in place
          oldGrid.forEach((box) => {
            box.destroy()
          })

          return
        }
        // If workflow not found, fall back to normal grid mode
        this.zoomedMode = false
      }

      // Calculate grid layout - use full width for single card
      this.cols = count === 1 ? 1 : Math.min(Math.ceil(Math.sqrt(count)), 3)
      this.rows = Math.ceil(count / this.cols)

      const boxWidth = Math.floor(screenWidth / this.cols)
      const boxHeight = Math.floor(screenHeight / this.rows)

      // Store box width for use in formatting
      this.currentBoxWidth = boxWidth

      // Create grid of boxes
      for (let i = 0; i < count; i++) {
        const row = Math.floor(i / this.cols)
        const col = i % this.cols
        const workflow = this.workflows[i]
        const borderColor = workflow
          ? this.getBorderColor(workflow, i === this.selectedIndex)
          : "#f0f0f0"

        const box = blessed.box({
          parent: this.screen,
          top: topOffset + row * boxHeight,
          left: col * boxWidth,
          width: boxWidth,
          height: boxHeight,
          tags: true,
          border: {
            type: "line",
          },
          style: {
            fg: "white",
            border: {
              fg: borderColor,
            },
          },
          scrollable: true,
          alwaysScroll: true,
          keys: true,
          vi: false,
        })

        newGrid.push(box)
      }

      // Now swap grids atomically - destroy old boxes AFTER creating new ones
      const oldGrid = this.grid
      this.grid = newGrid

      // Ensure selection highlighting is applied after creating all boxes
      this.highlightSelected()

      // Destroy old boxes after new ones are in place
      oldGrid.forEach((box) => {
        box.destroy()
      })
    } finally {
      this.layoutInProgress = false
    }
  }

  private renderWorkflows(workflows: Run[], jobs: Map<string, Job[]>): void {
    // Handle zoom mode - only render the zoomed workflow
    if (this.zoomedMode) {
      const workflow = workflows[this.zoomedWorkflowIndex]
      if (workflow && this.grid.length > 0) {
        const box = this.grid[0]
        const content = this.formatWorkflowContent(
          workflow,
          jobs.get(workflow.key) || [],
          true, // Always mark as selected in zoom mode
        )

        // Only update if content actually changed
        const currentContent = box.getContent()
        if (currentContent !== content) {
          box.setContent(content)
        }
      }

      this.updateStatusBar()
      this.scheduleRender()
      return
    }

    // Normal mode - render all workflows
    workflows.forEach((workflow, index) => {
      if (index >= this.grid.length) return

      const box = this.grid[index]
      const isSelected = index === this.selectedIndex
      const content = this.formatWorkflowContent(workflow, jobs.get(workflow.key) || [], isSelected)

      // Only update if content actually changed
      const currentContent = box.getContent()
      if (currentContent !== content) {
        box.setContent(content)
      }
    })

    this.updateStatusBar()

    // Schedule a single batched render
    this.scheduleRender()
  }

  private formatWorkflowContent(run: Run, jobs: Job[], isSelected: boolean = false): string {
    const lines: string[] = []

    // Determine if we should show all steps based on number of runs or zoom mode
    const showAllSteps = this.workflows.length <= 2 || this.zoomedMode

    // Map of known repo to working directory names (same as PRs)
    const repoToWorkingDir: Record<string, string> = {
      "phenixcrm/clean": "phenix",
      "phenixcrm/phenixcrm": "phenixcrm",
      // Add more mappings as needed
    }

    // Get working directory name
    const projectName = repoToWorkingDir[run.repo.fullName] || run.repo.name

    // Header with project name (working dir) and actual branch the run is on
    if (isSelected) {
      // Create full-width inverted header block
      const branchName = run.branch
      const repoLine = ` ${projectName} \ue725 ${branchName}`
      const runLine = ` ${run.pipeline || "CI"} Run #${run.number}`

      // Pad to actual card width minus border (2 chars) and some margin.
      // Padded as raw text, then escaped, so the padding counts what shows.
      const padWidth = Math.max(30, this.currentBoxWidth - 4)
      lines.push(`{inverse}${esc(repoLine.padEnd(padWidth))}{/inverse}`)
      lines.push(`{inverse}${esc(runLine.padEnd(padWidth))}{/inverse}`)
    } else {
      const branchName = run.branch
      lines.push(` {bold}${esc(projectName)} \ue725 ${esc(branchName)}{/bold}`)
      lines.push(` ${esc(run.pipeline) || "CI"} Run #{yellow-fg}${run.number}{/yellow-fg}`)
    }
    lines.push("")

    // What the run is actually building: the commit title, then who and which commit.
    if (run.title) {
      lines.push(` ${esc(run.title)}`)
    }
    if (run.event) {
      const by = run.actor ? ` {#888888-fg}by ${esc(run.actor)}{/#888888-fg}` : ""
      lines.push(` Triggered by: {magenta-fg}${esc(run.event)}{/magenta-fg}${by}`)
    } else if (run.actor) {
      lines.push(` Triggered by: {magenta-fg}${esc(run.actor)}{/magenta-fg}`)
    }
    if (run.sha) {
      lines.push(` Commit: {#888888-fg}${run.sha.substring(0, 7)}{/#888888-fg}`)
    }
    // Show repository owner in smaller text if needed
    lines.push(` Repo: {#888888-fg}${esc(run.repo.fullName)}{/#888888-fg}`)
    lines.push("")

    // Status with more detail
    const icon = statusIcon(run.status, run.isFailing)
    const color = statusColor(run.status, run.isFailing)
    lines.push(` Status: {${color}-fg}${icon} ${run.status.toUpperCase()}{/}`)

    // No separate Result line: with one neutral status there is no second
    // verdict to print, and it would just repeat the word above.
    if (isTerminal(run.status)) {
      // Show dismiss hint for finished runs
      lines.push(` {#888888-fg}Press 'd' to dismiss{/#888888-fg}`)
    }

    // Timing information. A finished run has an end; an in-flight one is
    // measured against now.
    if (run.startedAt) {
      const startTime = new Date(run.startedAt)
      const endTime = run.finishedAt ? new Date(run.finishedAt) : new Date()
      const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000)
      const minutes = Math.floor(duration / 60)
      const seconds = duration % 60
      const label = run.finishedAt ? "Duration" : "Running"
      lines.push(` ${label}: {white-fg}${minutes}m ${seconds}s{/white-fg}`)
    }

    if (run.createdAt !== run.startedAt) {
      const queueTime =
        new Date(run.startedAt || run.createdAt).getTime() - new Date(run.createdAt).getTime()
      if (queueTime > 1000) {
        const queueSeconds = Math.floor(queueTime / 1000)
        lines.push(` Queue time: {#888888-fg}${queueSeconds}s{/#888888-fg}`)
      }
    }

    lines.push("")

    // Jobs with detailed step information
    if (jobs.length > 0) {
      lines.push(" {bold}Jobs & Steps:{/bold}")
      jobs.forEach((job) => {
        const jobIcon = statusIcon(job.status)
        const jobColor = statusColor(job.status)
        const agentInfo = job.agent ? ` [${esc(job.agent)}]` : ""
        lines.push(
          ` {${jobColor}-fg}${jobIcon} ${esc(job.name)}{/${jobColor}-fg}{white-fg}${agentInfo}{/white-fg}`,
        )

        let hasSubSteps = false
        if (job.steps && job.steps.length > 0) {
          // Show progress for running jobs
          if (job.status === "running") {
            const completedSteps = job.steps.filter((s) => isTerminal(s.status)).length
            const totalSteps = job.steps.length
            const currentStepIndex = job.steps.findIndex((s) => s.status === "running")

            hasSubSteps = true
            lines.push(`   Progress: {cyan-fg}${completedSteps}/${totalSteps} steps{/cyan-fg}`)

            if (currentStepIndex >= 0) {
              // Show current step and remaining steps only (completed steps are noise)
              for (let i = currentStepIndex; i < job.steps.length; i++) {
                const step = job.steps[i]
                const stepNumber = `${i + 1}/${totalSteps}`

                if (step.status === "running") {
                  // Current running step - highlighted
                  const stepDuration = step.startedAt
                    ? Math.floor((Date.now() - new Date(step.startedAt).getTime()) / 1000)
                    : 0

                  lines.push(
                    `   {bold}{yellow-fg}▶ ${stepNumber} ${esc(step.name)} (${stepDuration}s){/yellow-fg}{/bold}`,
                  )
                } else {
                  // Upcoming steps (queued, or paused for a human)
                  const stepIcon = step.status === "blocked" ? "⏳" : "○"
                  lines.push(`   {white-fg}${stepIcon} ${stepNumber} ${esc(step.name)}{/white-fg}`)
                }
              }
            }
          }

          // Show completion info for finished jobs
          else if (isTerminal(job.status)) {
            const isExpanded = this.expandedJobs.has(job.key)

            if (!isExpanded) {
              // Only show detail for failed jobs (which step failed)
              if (job.status === "failed" || job.status === "timed_out") {
                const failedStep = job.steps.find(
                  (s) => s.status === "failed" || s.status === "timed_out",
                )
                if (failedStep) {
                  hasSubSteps = true
                  lines.push(`   {red-fg}✗ Failed at: ${esc(failedStep.name)}{/red-fg}`)
                }
              }
              // Passed jobs: no sub-steps, the job line itself shows the tick
            } else {
              hasSubSteps = true
              // Expanded: show all steps with details
              job.steps.forEach((step, index) => {
                const stepNumber = `${index + 1}/${job.steps?.length}`
                const stepIcon = statusIcon(step.status)
                const stepColor = statusColor(step.status)

                let duration = ""
                if (step.startedAt && step.finishedAt) {
                  const dur = Math.floor(
                    (new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()) /
                      1000,
                  )
                  duration = ` (${dur}s)`
                }

                lines.push(
                  `   {${stepColor}-fg}${stepIcon}{/${stepColor}-fg} {#888888-fg}${stepNumber}{/#888888-fg} ${esc(step.name)}{#888888-fg}${duration}{/#888888-fg}`,
                )
              })
            }
          }

          // Show queued job steps when there's room
          else if (showAllSteps && job.status === "queued") {
            hasSubSteps = true
            lines.push(`   {#888888-fg}Queued - ${job.steps.length} steps pending{/#888888-fg}`)
            job.steps.forEach((step, index) => {
              const stepNumber = `${index + 1}/${job.steps?.length}`
              lines.push(`   {#888888-fg}○ ${stepNumber} ${esc(step.name)}{/#888888-fg}`)
            })
          }
        }
        // Jobs without steps: a Buildkite command job, or one paused for a human.
        else if (job.type === "manual" && job.status === "blocked") {
          hasSubSteps = true
          lines.push(`   {cyan-fg}waiting for unblock{/cyan-fg}`)
        } else if (job.command) {
          hasSubSteps = true
          // Multi-line commands (a `command: |` block) show their first line.
          const firstLine = job.command.split(/\r?\n/, 1)[0]
          lines.push(`   {#888888-fg}${esc(firstLine)}{/#888888-fg}`)
        } else if (showAllSteps && job.status === "queued") {
          hasSubSteps = true
          lines.push(`   {#888888-fg}Waiting to start...{/#888888-fg}`)
        }

        // Only add spacing after jobs that have sub-step detail
        if (hasSubSteps) {
          lines.push("")
        }
      })
    } else {
      lines.push(" {#888888-fg}Loading job details...{/#888888-fg}")
    }

    return lines.join("\n")
  }

  /**
   * A compact, red status-bar segment for the current refresh's error-level
   * diagnostics — never info-level ones (a missing Buildkite token must stay
   * silent, not become a permanent warning for users with no Buildkite
   * account). Empty cards already show diagnostics in the empty-state panel,
   * but healthy GitHub cards can otherwise hide a Buildkite provider that is
   * loudly failing beside them; this is what keeps that visible without
   * relying on the event log, which scrolls away. `this.diagnostics` is
   * replaced wholesale on every `updateWorkflows` call, so this clears itself
   * the moment a refresh no longer reports the error — nothing lingers.
   */
  private errorDiagnosticsSegment(available: number): string {
    const errors = this.diagnostics.filter((d) => d.level === "error")
    if (errors.length === 0) return ""

    const extra = errors.length - 1
    const suffix = extra > 0 ? ` (+${extra} more)` : ""
    const prefix = " | ⚠ "
    // The message gets whatever the counts left over, capped at 60 so one
    // long error never dominates a wide terminal.
    const budget = Math.min(60, available - prefix.length - suffix.length)
    // Fewer than this many characters of a message is noise, not information.
    const MIN_MESSAGE = 12
    if (budget >= MIN_MESSAGE) {
      return ` | {red-fg}⚠ ${escTruncated(errors[0].message, budget)}${suffix}{/red-fg}`
    }
    const bare = ` | ⚠ ${errors.length} error${errors.length === 1 ? "" : "s"}`
    return bare.length <= available ? ` | {red-fg}${bare.slice(3)}{/red-fg}` : ""
  }

  setBudget(budget: Budget | undefined): void {
    this.budget = budget
    this.updateStatusBar()
  }

  setPollerStatus(status: PollerStatus): void {
    this.pollerStatus = status
    this.updateStatusBar()
  }

  private updateStatusBar(): void {
    const runningCount = this.workflows.filter((w) => w.status === "running").length
    const queuedCount = this.workflows.filter((w) => w.status === "queued").length
    // A build paused for a human is the most actionable thing on the screen.
    const blockedCount = this.workflows.filter((w) => w.status === "blocked").length
    const completedCount = this.workflows.filter((w) => isTerminal(w.status)).length

    // Animated refresh indicator - using braille spinner for smoothness
    // Always reserve space for the spinner to prevent text jumping
    const refreshFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    const refreshIndicator = this.refreshAnimationTimer
      ? `{yellow-fg}${refreshFrames[this.refreshAnimationFrame % refreshFrames.length]}{/} `
      : "  " // Two spaces when not spinning to prevent text jumping

    // Use last refresh time if available
    const updateTime = this.lastRefreshTime || new Date()

    // Line 1: Status counts and refresh indicator. It must never wrap: a
    // wrapped line pushes the shortcut line out of the 4-row box (a tmux
    // split is the usual culprit). The box's border takes two columns.
    const width = Math.max(0, (this.screen.width as number) - 2)
    const counts = (verbose: boolean): string => {
      let text = `{yellow-fg}●{/} ${verbose ? "Running: " : ""}${runningCount} | `
      text += `{#888888-fg}○{/} ${verbose ? "Queued: " : ""}${queuedCount}`
      if (blockedCount > 0) {
        text += ` | {cyan-fg}⏸{/} ${verbose ? "Blocked: " : ""}${blockedCount}`
      }
      if (completedCount > 0) {
        text += ` | {green-fg}✓{/} ${verbose ? "Done: " : ""}${completedCount}`
      }
      return `${text} | ${verbose ? "Total: " : "Σ "}${this.workflows.length}`
    }
    // Most to least verbose; the first that fits wins, and any error segment
    // gets whatever width is left after it.
    const candidates = [
      `${refreshIndicator}Last Update: ${updateTime.toLocaleTimeString()} | ${counts(true)}`,
      `${refreshIndicator}${counts(true)}`,
      `${refreshIndicator}${counts(false)}`,
    ]
    let line1 = candidates.find((c) => visibleLength(c) <= width) ?? candidates[2]
    line1 += this.errorDiagnosticsSegment(width - visibleLength(line1))
    // Whole segment or nothing: never truncate it mid-tag.
    const budgetText = budgetSegment(this.budget, this.pollerStatus, Date.now())
    if (visibleLength(line1) + visibleLength(budgetText) <= width) line1 += budgetText

    // Line 2: Context-aware keyboard shortcuts
    const shortcuts = this.getContextualShortcuts()
    const line2 = shortcuts.join(" | ")

    // Only update if content changed or spinner is active
    const contentChanged = line1 !== this.lastStatusLine1 || line2 !== this.lastStatusLine2

    if (contentChanged || this.refreshAnimationTimer) {
      this.statusBox.setContent(
        `{center}${line1}{/center}\n{center}{#888888-fg}${line2}{/#888888-fg}{/center}`,
      )
      this.lastStatusLine1 = line1
      this.lastStatusLine2 = line2
      this.screen.render()
    }
  }

  onRefresh(callback: () => void): void {
    this.screen.on("manual-refresh", callback)
  }

  onOpenRun(callback: (run: Run) => void): void {
    this.screen.on("open-workflow", callback)
  }

  onDismissRun(callback: (run: Run) => void): void {
    this.screen.on("dismiss-workflow", callback)
  }

  onDismissAllCompleted(callback: (runs: Run[]) => void): void {
    this.screen.on("dismiss-all-completed", callback)
  }

  onResurrectRun(callback: () => void): void {
    this.screen.on("resurrect-workflow", callback)
  }

  onOpenPR(callback: (pr: PullRequest) => void): void {
    this.screen.on("open-pr", callback)
  }

  onKillRun(callback: (run: Run) => void): void {
    this.screen.on("kill-workflow", callback)
  }

  onRestartDocker(
    callback: (service: {
      service: { name: string; state: string; health?: string }
      repo: string
    }) => void,
  ): void {
    this.screen.on("restart-docker", callback)
  }

  onDockerAction(
    callback: (
      action: string,
      service: {
        service: { name: string; state: string; health?: string }
        repo: string
        composeFile?: string
        isProject?: boolean
      },
    ) => void,
  ): void {
    this.screen.on("docker-action" as never, callback as never)
  }

  onPRMerge(callback: (pr: PullRequest, method: string) => void): void {
    this.screen.on("pr-merge" as never, callback as never)
  }

  onPRCheckout(callback: (pr: PullRequest) => void): void {
    this.screen.on("pr-checkout" as never, callback as never)
  }

  onPRAction(callback: (action: string, pr: PullRequest) => void): void {
    this.screen.on("pr-action" as never, callback as never)
  }

  onRunRerun(callback: (run: Run) => void): void {
    this.screen.on("workflow-rerun" as never, callback as never)
  }

  onRunLogs(callback: (run: Run) => void): void {
    this.screen.on("workflow-logs" as never, callback as never)
  }

  // Get contextual shortcuts based on current selection
  private getContextualShortcuts(): string[] {
    const baseShortcuts = ["?", "q", "↑↓←→", "U: resurrect"]

    switch (this.selectionMode) {
      case "docker": {
        const service = this.flatDockerServices[this.selectedDockerIndex]
        if (!service) return baseShortcuts

        if (service.isProject) {
          // Project-level commands
          const shortcuts = [...baseShortcuts, "Enter: up all"]
          shortcuts.push("s: start all", "t: stop all", "d: down", "l: logs")
          return shortcuts
        } else {
          // Service-level commands
          const shortcuts = [...baseShortcuts, "Enter: restart"]

          // Smart start/stop based on state
          if (service.service.state === "running") {
            shortcuts.push("s: stop")
          } else {
            shortcuts.push("s: start")
          }

          shortcuts.push("l: logs", "u: recreate", "x: shell")
          return shortcuts
        }
      }

      case "prs": {
        const pr = this.pullRequests[this.selectedPRIndex]
        if (!pr) return baseShortcuts

        const shortcuts = [...baseShortcuts, "Enter: open"]

        // Check if PR can be merged
        if (pr.mergeable === "MERGEABLE") {
          shortcuts.push("m: merge")
        }

        if (pr.isDraft) {
          shortcuts.push("r: ready")
        } else {
          shortcuts.push("r: to draft")
        }

        shortcuts.push("c: checkout", "d: diff")
        return shortcuts
      }
      default: {
        const workflow = this.workflows[this.selectedIndex]
        if (!workflow) return baseShortcuts

        const shortcuts = [...baseShortcuts, "Enter: open"]

        if (isActive(workflow.status)) {
          shortcuts.push("k: cancel")
          // A pipeline that blocks on a manual gate every run would otherwise
          // pile up cards nobody can clear.
          if (workflow.status === "blocked") shortcuts.push("d: dismiss")
        } else {
          shortcuts.push(`r: ${rerunVerb(workflow)}`, "d: dismiss")
        }

        shortcuts.push("l: logs")

        // Add job step expand/collapse shortcut if there are finished jobs
        const workflowJobs = this.jobsCache.get(workflow.key)
        const hasCompletedJobs = workflowJobs?.some((job) => isTerminal(job.status))
        if (hasCompletedJobs) {
          // Check if any jobs are expanded to show appropriate action
          const anyExpanded = workflowJobs?.some(
            (job) => isTerminal(job.status) && this.expandedJobs.has(job.key),
          )
          shortcuts.push(anyExpanded ? "j: collapse steps" : "j: expand steps")
        }

        return shortcuts
      }
    }
  }

  showError(message: string): void {
    // Clear existing content
    this.grid.forEach((box) => {
      box.destroy()
    })
    this.grid = []

    const errorBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "80%",
      height: "60%",
      content: `{center}{bold}Error Loading Workflows{/bold}{/center}

{red-fg}${message}{/red-fg}

{center}Press 'r' to retry or 'q' to quit{/center}`,
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        border: {
          fg: "red",
        },
      },
    })

    this.grid.push(errorBox)
    this.updateStatusBar()
    this.screen.render()
  }

  private cleanup(): void {
    // Save preferences before exit
    this.savePreferences()

    // Emit exit event for the app to handle
    this.screen.emit("exit")
    // Clean shutdown
    this.destroy()
    process.exit(0)
  }

  onExit(callback: () => void): void {
    this.screen.on("exit", callback)
  }

  showLoadingInStatus(): void {
    // Don't update status if modal is open
    if (this.modalOpen) return

    // Start animation if not already running
    if (!this.refreshAnimationTimer) {
      this.startRefreshAnimation()
    }

    // Log refresh
    this.log("Refreshing data...", "debug")
  }

  private startRefreshAnimation(): void {
    // Don't start if already running
    if (this.refreshAnimationTimer) return

    // Reset frame counter
    this.refreshAnimationFrame = 0

    // Update immediately to show spinner
    this.updateStatusBar()

    // Start animation with moderate speed - not too fast to be jarring
    this.refreshAnimationTimer = setInterval(() => {
      this.refreshAnimationFrame++
      this.updateStatusBar()
    }, 300) // 300ms for smooth, non-jarring animation
  }

  stopRefreshAnimation(): void {
    // Stop animation timer
    if (this.refreshAnimationTimer) {
      clearInterval(this.refreshAnimationTimer)
      this.refreshAnimationTimer = undefined
    }
    this.refreshAnimationFrame = 0

    // Record the actual refresh time
    this.lastRefreshTime = new Date()

    // Update status bar to remove refresh indicator
    this.updateStatusBar()
  }

  destroy(): void {
    // Save preferences before destroying
    this.savePreferences()

    // Clean up any event listeners
    process.removeAllListeners("SIGINT")
    process.removeAllListeners("SIGTERM")

    // Destroy the blessed screen
    if (this.screen) {
      this.screen.destroy()
    }
  }

  private createOrUpdatePRHeader(): void {
    // Remove existing PR header if it exists
    if (this.prHeaderBox) {
      this.prHeaderBox.destroy()
    }

    // Position PR header below Docker header if Docker header is shown
    const prTop = this.dockerHeaderBox ? 5 : 0

    // Create PR header box with border
    this.prHeaderBox = blessed.box({
      parent: this.screen,
      top: prTop,
      left: 0,
      width: "100%",
      height: 5,
      tags: true,
      focusable: false, // Don't capture focus
      keyable: false, // Don't capture keyboard events
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        // bg removed - inherit terminal background
        border: {
          fg: "#f0f0f0",
        },
      },
    })

    // Format PR content
    const prContent = this.formatPRHeader(this.pullRequests)
    this.prHeaderBox.setContent(prContent)
  }

  private createOrUpdateDockerHeader(): void {
    // Remove existing Docker header if it exists
    if (this.dockerHeaderBox) {
      this.dockerHeaderBox.destroy()
    }

    // Position Docker header above PR header if PR header is shown
    const dockerTop = 0

    // Create Docker header box with border
    this.dockerHeaderBox = blessed.box({
      parent: this.screen,
      top: dockerTop,
      left: 0,
      width: "100%",
      height: 5,
      tags: true,
      focusable: false, // Don't capture focus
      keyable: false, // Don't capture keyboard events
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        // bg removed - inherit terminal background
        border: {
          fg: "#888888",
        },
      },
    })

    // Format Docker content
    const dockerContent = this.formatDockerHeader(this.dockerServices)
    this.dockerHeaderBox.setContent(dockerContent)

    // If PR header exists, move it below Docker header
    if (this.prHeaderBox) {
      this.prHeaderBox.top = 5
    }
  }

  private formatDockerHeader(dockerStatuses: DockerServiceStatus[]): string {
    if (dockerStatuses.length === 0) {
      return "{center}{#888888-fg}No Docker services found{/#888888-fg}{/center}"
    }

    const lines: string[] = []

    // Rebuild flat list of services for navigation
    this.flatDockerServices = []

    // Collect all services with simplified format
    const services: Array<{
      name: string
      icon: string
      color: string
      repo: string
      composeFile: string
      state: string
      health?: string
    }> = []
    let hasErrors = false

    for (const status of dockerStatuses) {
      if (status.error) {
        hasErrors = true
        if (status.error.includes("not installed")) {
          lines.push("{center}{red-fg}⚠ Docker is not installed or not available{/red-fg}{/center}")
          return lines.join("\n")
        }
        continue
      }

      if (status.services.length === 0) {
        continue
      }

      const repoName = status.repository.split("/")[1] || status.repository

      for (const service of status.services) {
        // Strip project name prefix from service name if present
        let serviceName = service.name
        // Common patterns: projectname-servicename or projectname_servicename
        const prefixPatterns = [
          `${repoName}-`,
          `${repoName}_`,
          `${repoName.toLowerCase()}-`,
          `${repoName.toLowerCase()}_`,
        ]
        for (const prefix of prefixPatterns) {
          if (serviceName.startsWith(prefix)) {
            serviceName = serviceName.substring(prefix.length)
            break
          }
        }

        let icon = ""
        let color = "white"

        // Simplified icon logic - focus on health for running services
        if (service.state === "running") {
          if (service.health === "healthy") {
            icon = "✓"
            color = "green"
          } else if (service.health === "unhealthy") {
            icon = "✗"
            color = "red"
          } else if (service.health === "starting") {
            icon = "◐"
            color = "yellow"
          } else {
            icon = "●"
            color = "green"
          }
        } else if (service.state === "exited") {
          icon = "○"
          color = "#888888"
        } else if (service.state === "restarting") {
          icon = "↻"
          color = "yellow"
        } else if (service.state === "paused") {
          icon = "⏸"
          color = "yellow"
        } else {
          icon = "?"
          color = "#888888"
        }

        services.push({
          name: serviceName,
          icon,
          color,
          repo: repoName,
          composeFile: status.composeFile,
          state: service.state,
          health: service.health,
        })
      }
    }

    if (services.length === 0 && !hasErrors) {
      return "{center}{#888888-fg}No Docker services running{/#888888-fg}{/center}"
    }

    // Group by project (repo name without owner) for better organization
    const servicesByRepo = new Map<string, typeof services>()
    const composeFileByRepo = new Map<string, string>()
    for (const service of services) {
      const projectName = service.repo // Already just the project name from earlier
      if (!servicesByRepo.has(projectName)) {
        servicesByRepo.set(projectName, [])
        composeFileByRepo.set(projectName, service.composeFile)
      }
      servicesByRepo.get(projectName)?.push(service)
    }

    // Format as compact inline list per repo with left margin
    let serviceIndex = 0
    for (const [project, repoServices] of servicesByRepo) {
      // Add project name as selectable item
      const isProjectSelected =
        this.selectionMode === "docker" && serviceIndex === this.selectedDockerIndex
      const projectText = isProjectSelected
        ? `{inverse} ${project} {/inverse}`
        : `{bold}${project}{/bold}`

      this.flatDockerServices.push({
        service: { name: project, state: "project", health: undefined },
        repo: project,
        composeFile: composeFileByRepo.get(project),
        isProject: true,
      })
      serviceIndex++

      const serviceItems = repoServices
        .map((s, idx) => {
          const isSelected =
            this.selectionMode === "docker" && serviceIndex + idx === this.selectedDockerIndex
          const serviceText = `{${s.color}-fg}${s.icon}{/} ${s.name}`

          // Add to flat list for navigation
          this.flatDockerServices.push({
            service: {
              name: s.name,
              state: s.state,
              health: s.health,
            },
            repo: s.repo,
            composeFile: s.composeFile,
            isProject: false,
          })

          if (isSelected) {
            // Apply inverse to selected service with padding for button-like appearance
            const plainText = ` ${s.icon} ${s.name} ` // Added spaces on both sides
            return `{inverse}${plainText}{/inverse}`
          }
          return serviceText
        })
        .join("  ") // Two spaces between services

      lines.push(` ${projectText} ${serviceItems}`) // Project name (selectable), then services
      serviceIndex += repoServices.length
    }

    // If we have too many lines, truncate and show count
    const maxLines = 4 // We can show more lines now without the whale
    if (lines.length > maxLines) {
      const totalServices = services.length
      lines.splice(
        maxLines,
        lines.length,
        ` {#888888-fg}... ${totalServices} services total{/#888888-fg}`,
      ) // 1-space margin
    }

    return lines.join("\n") // All lines fit in 5-height box now
  }

  private formatPRHeader(prs: PullRequest[]): string {
    if (prs.length === 0) {
      return "{center}{#888888-fg}No open pull requests{/#888888-fg}{/center}"
    }

    const lines: string[] = []

    // Map of known repo to working directory names
    const repoToWorkingDir: Record<string, string> = {
      "phenixcrm/clean": "phenix",
      "phenixcrm/phenixcrm": "phenixcrm",
      // Add more mappings as needed
    }

    // Group PRs by repository
    const prsByRepo = new Map<string, PullRequest[]>()
    for (const pr of prs) {
      const key = `${pr.repository.owner}/${pr.repository.name}`
      if (!prsByRepo.has(key)) {
        prsByRepo.set(key, [])
      }
      prsByRepo.get(key)?.push(pr)
    }

    // Format each PR as branch flow
    const prLines: string[] = []
    let currentIndex = 0
    for (const [repo, repoPrs] of prsByRepo) {
      for (const pr of repoPrs) {
        const isSelected = this.selectionMode === "prs" && currentIndex === this.selectedPRIndex
        if (isSelected) {
          this.log(
            `PR ${currentIndex} is selected (selectedPRIndex=${this.selectedPRIndex})`,
            "trace",
          )
        }
        let statusIcon = ""
        let statusColor = "white"

        // Check status for icon
        if (pr.statusCheckRollup) {
          switch (pr.statusCheckRollup.state) {
            case "SUCCESS":
              statusIcon = "✓"
              statusColor = "green"
              break
            case "FAILURE":
            case "ERROR":
              statusIcon = "✗"
              statusColor = "red"
              break
            case "PENDING":
            case "EXPECTED":
              statusIcon = "●"
              statusColor = "yellow"
              break
          }
        } else {
          statusIcon = "○"
          statusColor = "#888888"
        }

        // Add draft indicator to status icon if needed
        if (pr.draft || pr.isDraft) {
          statusIcon = "◐" // Half-circle for draft
          statusColor = "#888888"
        }

        // Add conflict indicator if not mergeable
        let conflictIndicator = ""
        if (pr.mergeable === "CONFLICTING") {
          conflictIndicator = " {red-fg}⚠{/red-fg}" // Warning triangle for conflicts
        }

        // Format: project PR# source -> target icon [conflict]
        // Use working directory name if we have a mapping, otherwise use repo name
        const projectName = repoToWorkingDir[repo] || repo.split("/")[1] || repo
        const prText = `{bold}${projectName}{/bold} {cyan-fg}PR #${pr.number}{/} ${pr.headRefName} → ${pr.baseRefName} {${statusColor}-fg}${statusIcon}{/}${conflictIndicator}`

        // Format the PR line
        let prLine: string
        if (isSelected && this.selectionMode === "prs") {
          // For selected PR, create plain text and apply inverse to entire padded line
          const plainText = `${projectName} PR #${pr.number} ${pr.headRefName} → ${pr.baseRefName} ${statusIcon}${pr.mergeable === "CONFLICTING" ? " ⚠" : ""}`
          // Pad the text to a reasonable width before applying inverse
          const paddedText = plainText.padEnd(Math.min(80, (this.screen.width as number) - 4))
          prLine = `{inverse}${paddedText}{/inverse}`
        } else {
          prLine = prText
        }

        prLines.push(prLine)
        currentIndex++
      }
    }

    // Show up to 2 PRs horizontally if space allows, otherwise just list them
    const screenWidth = this.screen.width as number
    if (screenWidth > 160 && prLines.length >= 2) {
      // Two column layout
      const half = Math.ceil(prLines.length / 2)
      const leftColumn = prLines.slice(0, half)
      const rightColumn = prLines.slice(half)

      for (let i = 0; i < Math.max(leftColumn.length, rightColumn.length); i++) {
        const left = leftColumn[i] || ""
        const right = rightColumn[i] || ""
        // Simple two column layout with left margin - left takes up to 80 chars, right gets the rest
        lines.push(` ${left.padEnd(Math.min(80, screenWidth / 2))} ${right}`) // 1-space margin
      }
    } else {
      // Single column layout with left margin - now we can show 4 PRs since we removed the header
      for (const prLine of prLines.slice(0, 4)) {
        lines.push(` ${prLine}`) // 1-space margin
      }
      if (prLines.length > 4) {
        lines.push(` {#888888-fg}... and ${prLines.length - 4} more{/#888888-fg}`) // 1-space margin
      }
    }

    return lines.join("\n") // All lines available for PRs now
  }

  log(message: string, type: "info" | "event" | "debug" | "trace" | "error" = "info"): void {
    const timestamp = new Date().toLocaleTimeString()
    const typeColors = {
      info: "{white-fg}",
      event: "{green-fg}",
      debug: "{cyan-fg}",
      trace: "{#888888-fg}",
      error: "{red-fg}",
    }
    const color = typeColors[type as keyof typeof typeColors] || "{white-fg}"
    const formattedMessage = `${color}[${timestamp}] ${message}{/}`

    this.logMessages.push({
      message,
      type,
      timestamp,
      formatted: formattedMessage,
    })

    // Keep only the last N messages
    if (this.logMessages.length > this.maxLogMessages) {
      this.logMessages = this.logMessages.slice(-this.maxLogMessages)
    }

    // Update the debug box content if it's visible (but batch updates)
    if (this.showDebug && !this.debugBox.hidden) {
      // Use a debounced update to avoid too many renders
      if (!this.debugUpdateTimer) {
        this.debugUpdateTimer = setTimeout(() => {
          this.updateDebugBox()
          this.debugUpdateTimer = undefined
        }, 100) // Update after 100ms of no new logs
      }
    }
  }

  private updateDebugBox(): void {
    if (!this.debugBox) return

    // Define log level hierarchy
    const levelHierarchy = {
      info: 0, // Show only info, event, and error
      debug: 1, // Also show debug
      trace: 2, // Show everything including trace
    }

    const currentLevelValue = levelHierarchy[this.logLevel]

    // Filter messages based on log level
    const filteredMessages = this.logMessages
      .filter((msg) => {
        // Always show info, event, and error
        if (msg.type === "info" || msg.type === "event" || msg.type === "error") return true
        // Show debug if level is debug or higher
        if (msg.type === "debug") return currentLevelValue >= levelHierarchy.debug
        // Show trace only if level is trace
        if (msg.type === "trace") return currentLevelValue >= levelHierarchy.trace
        return true
      })
      .map((msg) => msg.formatted)

    // Create colored log level indicator for the title
    const levelIndicator =
      this.logLevel === "info"
        ? "{white-fg}[INFO]{/}"
        : this.logLevel === "debug"
          ? "{cyan-fg}[DEBUG]{/}"
          : "{#888888-fg}[TRACE]{/}"

    // Auto-show indicator - clear ON/OFF text
    const autoShowStatus = this.autoShowDebug ? "{green-fg}ON{/}" : "{#888888-fg}OFF{/}"

    // Update the label to show colored log level and auto-show status
    this.debugBox.setLabel(
      ` Event Log ${levelIndicator} (F9: hide, F10: cycle level, a: auto-open ${autoShowStatus}) `,
    )

    // Set filtered messages as scrollable content
    this.debugBox.setContent(filteredMessages.join("\n"))

    // Auto-scroll to bottom to show latest messages
    this.debugBox.setScrollPerc(100)

    this.screen.render()
  }

  private toggleDebug(): void {
    try {
      this.showDebug = !this.showDebug

      if (this.showDebug) {
        this.debugBox.show()
        const autoShowStatus = this.autoShowDebug ? " (auto-show ON)" : " (auto-show OFF)"
        const debugFilterStatus =
          this.logLevel === "trace"
            ? " (showing all)"
            : this.logLevel === "debug"
              ? " (showing debug)"
              : " (info only)"
        this.log(
          `Event log enabled (height: ${this.debugBoxHeight} lines, Ctrl+k/d to resize)${autoShowStatus}${debugFilterStatus}`,
          "info",
        )
        this.updateDebugBox()
      } else {
        this.debugBox.hide()
      }

      // Re-layout to adjust for the debug box
      this.layoutWorkflows()
      this.screen.render()
    } catch (error) {
      // Try to log the error if possible
      if (this.logMessages) {
        this.log(`Error toggling debug: ${error}`, "error")
      }
    }
  }

  private toggleAutoShowDebug(): void {
    this.autoShowDebug = !this.autoShowDebug

    // Save the preference
    this.savePreferences()

    // Show feedback about the setting change
    if (this.autoShowDebug) {
      this.log("Event log will auto-show on startup ✓ ('a' to toggle)", "event")
    } else {
      this.log("Event log will be hidden on startup ('a' to toggle)", "event")
    }

    // Update the title to reflect the new setting
    if (this.showDebug) {
      this.updateDebugBox()
    }

    // Don't change current visibility - this setting only affects startup behavior
  }

  private toggleJobStepsCollapse(): void {
    const workflow = this.workflows[this.selectedIndex]
    if (!workflow) return

    // For job step collapse, we'll collapse/expand based on the selected run's jobs
    const workflowJobs = this.jobsCache.get(workflow.key)
    if (!workflowJobs || workflowJobs.length === 0) return

    // Find finished jobs in the run
    const completedJobs = workflowJobs.filter((job) => isTerminal(job.status))
    if (completedJobs.length === 0) return

    // Check if any completed jobs are currently expanded (since collapsed is default)
    const anyExpanded = completedJobs.some((job) => this.expandedJobs.has(job.key))

    if (anyExpanded) {
      // Collapse all completed jobs for this run (remove from expanded set)
      completedJobs.forEach((job) => {
        this.expandedJobs.delete(job.key)
      })
      this.log("Collapsed job steps for completed jobs", "info")
    } else {
      // Expand all completed jobs for this run (add to expanded set)
      completedJobs.forEach((job) => {
        this.expandedJobs.add(job.key)
      })
      this.log("Expanded job steps for completed jobs", "info")
    }

    // Re-render the display
    this.renderWorkflows(this.workflows, this.jobsCache)
  }

  private toggleZoomMode(): void {
    const workflow = this.workflows[this.selectedIndex]
    if (!workflow) return

    this.zoomedMode = !this.zoomedMode

    if (this.zoomedMode) {
      // Entering zoom mode - save the selected workflow
      this.zoomedWorkflowIndex = this.selectedIndex
      this.log(`Zoomed on workflow: ${workflow.title || workflow.pipeline}`, "info")
    } else {
      // Exiting zoom mode
      this.log("Exited zoom mode", "info")
    }

    // Re-layout to show zoomed or normal view
    this.layoutWorkflows()
    this.renderWorkflows(this.workflows, this.jobsCache)
  }

  private updateDebugInfo(info: {
    showPRs: boolean
    prCount: number
    workflowCount: number
    jobsLoaded: number
    lastUpdate: string
  }): void {
    // Log state changes at trace level (most verbose)
    this.log(
      `State: PRs=${info.prCount}, Workflows=${info.workflowCount}, Jobs=${info.jobsLoaded}`,
      "trace",
    )
  }

  private resizeDebugBox(delta: number): void {
    const newHeight = this.debugBoxHeight + delta

    // Constrain within min/max bounds
    if (newHeight < this.minDebugHeight || newHeight > this.maxDebugHeight) {
      return
    }

    this.debugBoxHeight = newHeight
    this.debugBox.height = newHeight

    // Log the resize
    this.log(`Event log resized to ${newHeight} lines (Ctrl+k/d to resize)`, "info")

    // Save preferences
    this.savePreferences()

    // Re-layout to adjust for new height
    this.layoutWorkflows()
    this.screen.render()
  }

  private loadPreferences(): void {
    try {
      const prefsPath = path.join(os.homedir(), ".ops-hud-prefs.json")
      // Fall back to the pre-rename prefs file so an upgrading user's saved
      // layout survives; savePreferences() always writes the new path, so
      // this fallback is only ever read, never written.
      const legacyPrefsPath = path.join(os.homedir(), ".gh-hud-prefs.json")
      const readPath = fs.existsSync(prefsPath) ? prefsPath : legacyPrefsPath

      // Store preference info for logging after UI is ready
      this.pendingPrefsLog = [`Preferences file: ${readPath}`]

      if (fs.existsSync(readPath)) {
        const content = fs.readFileSync(readPath, "utf8")
        if (content) {
          const prefs = JSON.parse(content)
          this.pendingPrefsLog.push(`Loaded preferences: ${JSON.stringify(prefs)}`)

          if (prefs.debugBoxHeight !== undefined) {
            const oldHeight = this.debugBoxHeight
            this.debugBoxHeight = Math.max(
              this.minDebugHeight,
              Math.min(this.maxDebugHeight, prefs.debugBoxHeight),
            )
            this.pendingPrefsLog.push(`Debug box height: ${oldHeight} → ${this.debugBoxHeight}`)
            // Apply the saved height to the debug box
            if (this.debugBox) {
              this.debugBox.height = this.debugBoxHeight
            }
          }

          // Load auto-show preference
          if (prefs.autoShowDebug !== undefined) {
            this.autoShowDebug = prefs.autoShowDebug
            // Apply the auto-show preference on startup
            this.showDebug = prefs.autoShowDebug
            this.pendingPrefsLog.push(`Auto-show debug: ${prefs.autoShowDebug ? "ON" : "OFF"}`)
            this.pendingPrefsLog.push(
              `Debug box will be ${this.showDebug ? "shown" : "hidden"} on startup`,
            )
          }

          // Load log level preference
          if (prefs.logLevel !== undefined) {
            this.logLevel = prefs.logLevel
            this.pendingPrefsLog.push(`Log level: ${prefs.logLevel}`)
          }
        }
      } else {
        this.pendingPrefsLog.push("No preferences file found, using defaults")
      }
    } catch (error: unknown) {
      // Store error for logging after UI is ready
      this.pendingPrefsLog = [
        `Failed to load preferences: ${error instanceof Error ? error.message : String(error)}`,
      ]
    }
  }

  private savePreferences(): void {
    try {
      // Always the new path — loadPreferences() reads the legacy one only
      // as a fallback, so the first save migrates the user off it.
      const prefsPath = path.join(os.homedir(), ".ops-hud-prefs.json")

      const prefs = {
        debugBoxHeight: this.debugBoxHeight,
        autoShowDebug: this.autoShowDebug,
        logLevel: this.logLevel,
        savedAt: new Date().toISOString(),
      }

      fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2))
      this.log(
        `Preferences saved: height=${this.debugBoxHeight}, auto-show=${this.autoShowDebug}`,
        "debug",
      )
    } catch (error: unknown) {
      this.log(
        `Failed to save preferences: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      )
    }
  }

  // Track workflow status changes
  private trackWorkflowChanges(newWorkflows: Run[]): void {
    // Keyed by Run.key: ids are only unique within a provider.
    const oldWorkflowMap = new Map(this.workflows.map((w) => [w.key, w]))

    for (const workflow of newWorkflows) {
      const oldWorkflow = oldWorkflowMap.get(workflow.key)

      if (!oldWorkflow) {
        // New run appeared
        this.log(
          `New workflow: ${workflow.repo.fullName} - ${workflow.pipeline} #${workflow.number}`,
          "event",
        )
      } else if (oldWorkflow.status !== workflow.status) {
        if (isTerminal(workflow.status)) {
          // Reached a verdict
          this.log(
            `Completed: ${workflow.pipeline} #${workflow.number}: ${workflow.status}`,
            "event",
          )
        } else {
          this.log(
            `Status change: ${workflow.pipeline} #${workflow.number}: ${oldWorkflow.status} → ${workflow.status} ${statusIcon(workflow.status, workflow.isFailing)}`,
            "event",
          )
        }
      }
    }

    // Check for removed runs
    for (const oldWorkflow of this.workflows) {
      if (!newWorkflows.find((w) => w.key === oldWorkflow.key)) {
        this.log(`Removed: ${oldWorkflow.pipeline} #${oldWorkflow.number}`, "event")
      }
    }
  }
}

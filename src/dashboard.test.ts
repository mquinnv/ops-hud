import { afterAll, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import blessed from "blessed"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Budget } from "./poller/protocol.js"
import type { Job, Run, Step } from "./types.js"

// The Dashboard reads and writes ~/.ops-hud-prefs.json on construction and on
// destroy. Point HOME somewhere disposable before it is ever imported.
const originalHome = process.env.HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "ops-hud-dashboard-test-"))

const { Dashboard, budgetSegment } = await import("./dashboard.js")

// Give blessed a throwaway input/output pair instead of the real terminal.
// blessed still writes its enter/leave alternate-screen escape sequences,
// but they land in this PassThrough and are discarded, never in the test
// runner's own stdout — so the suite is safe to run without a TTY (this
// matters for `prepublishOnly`, which runs `bun test` during npm release).
const output = new PassThrough()
output.resume() // drain so blessed's writes never back up
// A PassThrough has no `columns`, and blessed then assumes a 1-column
// terminal. Give it a realistic width; width-specific tests set their own.
;(output as unknown as { columns: number }).columns = 160
const dashboard = new Dashboard({ input: new PassThrough(), output })

afterAll(() => {
  dashboard.destroy()
  if (originalHome) process.env.HOME = originalHome
})

/** The card renderer, which is private for every caller but this one. */
const card = (run: Run, jobs: Job[] = [], selected = false): string =>
  (
    dashboard as unknown as {
      formatWorkflowContent(run: Run, jobs: Job[], selected: boolean): string
    }
  ).formatWorkflowContent(run, jobs, selected)

function makeRun(partial: Partial<Run> = {}): Run {
  return {
    provider: "github",
    key: "github:acme/widgets:1",
    id: "1",
    number: 42,
    title: "fix: stop the widget exploding",
    pipeline: "CI",
    branch: "main",
    sha: "0123456789abcdef",
    status: "running",
    isFailing: false,
    repo: { owner: "acme", name: "widgets", fullName: "acme/widgets" },
    actor: "someone",
    event: "push",
    webUrl: "https://example.test/run",
    createdAt: "2026-09-17T10:00:00Z",
    startedAt: "2026-09-17T10:00:00Z",
    ...partial,
  }
}

function step(name: string, status: Step["status"], number: number): Step {
  return { name, status, number }
}

function makeJob(partial: Partial<Job> = {}): Job {
  return {
    id: "j1",
    key: "github:acme/widgets:1:j1",
    runKey: "github:acme/widgets:1",
    name: "build",
    status: "running",
    ...partial,
  }
}

describe("a run still in flight", () => {
  const run = makeRun({ status: "running" })

  test("leads with the commit title", () => {
    expect(card(run)).toContain(" fix: stop the widget exploding")
  })

  test("shows what triggered it, with the actor behind the event", () => {
    expect(card(run)).toContain("Triggered by: {magenta-fg}push{/magenta-fg}")
    expect(card(run)).toContain("by someone")
  })

  test("prints one status line and no duplicate verdict", () => {
    const content = card(run)
    expect(content).toContain("Status: {yellow-fg}● RUNNING{/}")
    expect(content).not.toContain("Result:")
  })

  test("counts time against now, and does not offer dismissal", () => {
    const content = card(run)
    expect(content).toContain("Running: {white-fg}")
    expect(content).not.toContain("Duration:")
    expect(content).not.toContain("Press 'd' to dismiss")
  })

  test("shows step progress for the running job", () => {
    const job = makeJob({
      status: "running",
      steps: [step("checkout", "passed", 1), step("test", "running", 2), step("ship", "queued", 3)],
    })

    const content = card(run, [job])
    expect(content).toContain("Progress: {cyan-fg}1/3 steps{/cyan-fg}")
    expect(content).toContain("▶ 2/3 test")
    expect(content).toContain("○ 3/3 ship")
  })
})

describe("a run that is going to fail", () => {
  // Buildkite reports this directly; for GitHub applyIsFailing derives it. The
  // card has to make "running, but doomed" look different from "running".
  const run = makeRun({ status: "running", isFailing: true })

  test("turns the running marker red", () => {
    expect(card(run)).toContain("Status: {red-fg}◉ RUNNING{/}")
  })

  test("still offers no dismissal — it has not finished", () => {
    expect(card(run)).not.toContain("Press 'd' to dismiss")
  })
})

describe("a finished run", () => {
  const run = makeRun({
    status: "failed",
    startedAt: "2026-09-17T10:00:00Z",
    finishedAt: "2026-09-17T10:02:30Z",
  })

  test("shows the verdict once", () => {
    const content = card(run)
    expect(content).toContain("Status: {red-fg}✗ FAILED{/}")
    expect(content).not.toContain("Result:")
  })

  test("shows how long it took, not how long ago it started", () => {
    const content = card(run)
    expect(content).toContain("Duration: {white-fg}2m 30s{/white-fg}")
    expect(content).not.toContain("Running:")
  })

  test("offers dismissal", () => {
    expect(card(run)).toContain("Press 'd' to dismiss")
  })

  test("names the step that failed", () => {
    const job = makeJob({
      status: "failed",
      steps: [step("checkout", "passed", 1), step("test", "failed", 2)],
    })

    expect(card(run, [job])).toContain("✗ Failed at: test")
  })
})

describe("jobs with no steps", () => {
  const run = makeRun({ status: "blocked" })

  test("a manual job waiting on a human says so", () => {
    const job = makeJob({ name: "deploy", status: "blocked", type: "manual" })
    expect(card(run, [job])).toContain("waiting for unblock")
  })

  test("a command job shows its command", () => {
    const job = makeJob({ status: "running", command: "bun run deploy" })
    expect(card(run, [job])).toContain("bun run deploy")
  })

  test("a blocked run is paused, not running or finished", () => {
    const content = card(run)
    expect(content).toContain("Status: {cyan-fg}⏸ BLOCKED{/}")
    expect(content).not.toContain("Press 'd' to dismiss")
  })
})

// The grid, whose boxes carry the empty-state instructions or the run cards —
// whichever `layoutWorkflows` most recently built.
const gridBoxes = (): Array<{ getContent(): string }> =>
  (dashboard as unknown as { grid: Array<{ getContent(): string }> }).grid

describe("empty-state diagnostics", () => {
  // A Buildkite misconfiguration on a checkout with no GitHub Actions runs
  // must not look like idle CI — the empty state has to say why each
  // provider contributed nothing.
  test("a diagnostic renders in the empty state when the grid has no cards", () => {
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [
      {
        provider: "buildkite",
        level: "info",
        message: "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
      },
    ])

    const content = gridBoxes()[0]?.getContent() ?? ""
    expect(content).toContain(
      "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
    )
  })

  test("error-level diagnostics are visually distinct from info-level ones", () => {
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "info", message: "an info diagnostic" },
      { provider: "buildkite", level: "error", message: "a rejected-token diagnostic" },
    ])

    // blessed (tags: true) parses `{red-fg}`/`{white-fg}` into their SGR
    // escape codes by the time getContent() returns them, so the tag
    // survives only as that distinct color code around each message.
    const content = gridBoxes()[0]?.getContent() ?? ""
    const esc = String.fromCharCode(27)
    const colorBefore = (message: string): string | undefined =>
      content.slice(0, content.indexOf(message)).match(new RegExp(`${esc}\\[(\\d+)m$`))?.[1]

    const infoColor = colorBefore("an info diagnostic")
    const errorColor = colorBefore("a rejected-token diagnostic")
    expect(infoColor).toBeDefined()
    expect(errorColor).toBeDefined()
    expect(errorColor).not.toBe(infoColor)
    expect(errorColor).toBe("31") // red — matches the event log's error color
  })

  test("diagnostics disappear from the empty state once the grid is truly empty of them", () => {
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])

    const content = gridBoxes()[0]?.getContent() ?? ""
    expect(content).not.toContain("diagnostic")
  })

  test("diagnostics are not shown once the grid has cards", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "should never render on a card" },
    ])

    const content = gridBoxes()
      .map((box) => box.getContent())
      .join("\n")
    expect(content).not.toContain("should never render on a card")

    // Leave the dashboard back in its empty, diagnostic-free starting state
    // for any test that runs after this one in the shared instance.
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
  })
})

// The persistent status-bar warning (Ruling 29): with real, healthy cards on
// screen — e.g. GitHub runs from phenixcrm/* — a Buildkite provider that is
// loudly failing on inetalliance/* must not be reduced to one line in the
// scrolling event log. Only error-level diagnostics ever reach here; a
// missing-token info diagnostic must stay silent for accounts with no
// Buildkite at all.
const statusBarContent = (): string =>
  (dashboard as unknown as { statusBox: { getContent(): string } }).statusBox.getContent()

describe("status-bar error diagnostics", () => {
  test("an error diagnostic appears in the status bar alongside existing cards", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      {
        provider: "buildkite",
        level: "error",
        message: "Buildkite: token rejected — check scopes",
      },
    ])

    expect(statusBarContent()).toContain("Buildkite: token rejected — check scopes")
  })

  test("an info diagnostic never appears in the status bar", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      {
        provider: "buildkite",
        level: "info",
        message: "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
      },
    ])

    expect(statusBarContent()).not.toContain("Buildkite: no token")
  })

  test("the indicator disappears once a refresh no longer reports the error", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "Buildkite: token rejected" },
    ])
    expect(statusBarContent()).toContain("token rejected")

    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [])
    expect(statusBarContent()).not.toContain("token rejected")
  })

  test("several errors show the first message plus a count of the rest", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "first error" },
      { provider: "github", level: "error", message: "second error" },
      { provider: "github", level: "error", message: "third error" },
    ])

    const content = statusBarContent()
    expect(content).toContain("first error")
    expect(content).toContain("+2 more")
    expect(content).not.toContain("second error")

    // Leave the shared dashboard back in its diagnostic-free starting state.
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
  })
})

// Provider-accurate wording (ops-hud Task 8): GitHub Actions calls a run a
// "workflow run" and re-triggering it a "rerun"; Buildkite calls the same
// things a "build" and a "rebuild". The UI must say whichever the run's own
// provider uses, never one hard-coded term for both.
describe("provider-accurate wording", () => {
  const showKillConfirmation = (run: Run): string => {
    ;(dashboard as unknown as { showKillConfirmation(run: Run): void }).showKillConfirmation(run)
    const content = (
      dashboard as unknown as { confirmBox: { getContent(): string } }
    ).confirmBox.getContent()
    // Close it again so it doesn't block the next test — updateWorkflows()
    // is a no-op while a modal is open.
    ;(dashboard as unknown as { hideKillConfirmation(): void }).hideKillConfirmation()
    return content
  }

  test("a Buildkite run's kill confirmation says 'build', not 'workflow run'", () => {
    const run = makeRun({ provider: "buildkite" })
    const content = showKillConfirmation(run)
    expect(content).toContain("build")
    expect(content).not.toContain("workflow run")
  })

  test("a GitHub run's kill confirmation says 'workflow run'", () => {
    const run = makeRun({ provider: "github" })
    const content = showKillConfirmation(run)
    expect(content).toContain("workflow run")
  })

  const shortcutsFor = (run: Run): string[] => {
    dashboard.updateWorkflows([run], new Map())
    return (dashboard as unknown as { getContextualShortcuts(): string[] }).getContextualShortcuts()
  }

  test("a finished Buildkite run offers 'rebuild', not 'rerun'", () => {
    const run = makeRun({ provider: "buildkite", status: "passed" })
    const shortcuts = shortcutsFor(run)
    expect(shortcuts).toContain("r: rebuild")
    expect(shortcuts.some((s) => s.includes("rerun"))).toBe(false)
  })

  test("a blocked run offers dismissal", () => {
    const shortcuts = shortcutsFor(makeRun({ provider: "buildkite", status: "blocked" }))
    expect(shortcuts).toContain("d: dismiss")
  })

  test("a running run still does not offer dismissal", () => {
    const shortcuts = shortcutsFor(makeRun({ provider: "buildkite", status: "running" }))
    expect(shortcuts).not.toContain("d: dismiss")
  })

  test("a finished GitHub run offers 'rerun'", () => {
    const run = makeRun({ provider: "github", status: "passed" })
    const shortcuts = shortcutsFor(run)
    expect(shortcuts).toContain("r: rerun")

    // Leave the shared dashboard back in its empty starting state.
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
  })
})

// Ruling 38: blessed parses `{word}` as a tag. Anything that came from an API
// or a user must reach the screen literally.
const ESC = String.fromCharCode(27)
/** What the terminal would actually show for tagged content: tags applied, colours dropped. */
const rendered = (tagged: string): string =>
  blessed.parseTags(tagged).replace(new RegExp(`${ESC}\\[[\\d;]*m`, "g"), "")

describe("escaping API-sourced text", () => {
  // blessed 0.1.81 leaves a brace pair whose word is not a style literal, so
  // `${BUILDKITE_COMMIT}` alone survived even unescaped; a variable that
  // happens to be named like a style (`${red}`, `${bold}`) was swallowed.
  test("a command's shell variables render literally, even one named like a style", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell variable is the point
    const command = "echo ${BUILDKITE_COMMIT} ${red}${bold}"
    const job = makeJob({ status: "running", command })
    expect(rendered(card(makeRun(), [job]))).toContain(command)
  })

  test("a multi-line command shows its first line only", () => {
    const job = makeJob({ status: "running", command: "make build\nmake test" })
    const shown = rendered(card(makeRun(), [job]))
    expect(shown).toContain("make build")
    expect(shown).not.toContain("make test")
  })

  test("braces in a job name, title, pipeline, branch and actor survive", () => {
    const run = makeRun({
      title: "feat: {bold} markup",
      pipeline: "deploy {blue-fg}",
      branch: "fix/{underline}",
      actor: "{red}bot",
    })
    const job = makeJob({ name: "test {/} unit", status: "running" })
    const shown = rendered(card(run, [job]))
    for (const text of [
      "feat: {bold} markup",
      "deploy {blue-fg}",
      "fix/{underline}",
      "{red}bot",
      "test {/} unit",
    ]) {
      expect(shown).toContain(text)
    }
    const selected = rendered(card(run, [job], true))
    expect(selected).toContain("fix/{underline}")
    expect(selected).toContain("deploy {blue-fg}")
  })

  test("a diagnostic containing {/} does not reset the status-bar colour", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "Unexpected token {/} in JSON" },
    ])

    const content = statusBarContent()
    expect(content).toContain("Unexpected token {/} in JSON")
    // Still red after the braces: nothing reset the colour mid-message.
    const afterBraces = content.slice(content.indexOf("{/}") + 3, content.indexOf(" in JSON"))
    expect(afterBraces).not.toContain(`${ESC}[`)
    const beforeMessage = content.slice(0, content.indexOf("Unexpected token"))
    expect(beforeMessage).toContain(`${ESC}[31m`)

    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
  })

  test("a diagnostic with braces renders literally in the empty state", () => {
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "Unexpected token {/} at {bold}" },
    ])

    const content = gridBoxes()[0]?.getContent() ?? ""
    expect(content).toContain("Unexpected token {/} at {bold}")

    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
  })
})

// Deferred item 10: in a tmux split, a wrapped status line pushes the
// shortcut line out of the 4-row box.
describe("status-bar width", () => {
  const program = (dashboard as unknown as { screen: { program: { cols: number } } }).screen.program

  /** Line 1 as the terminal shows it: tags parsed, colours and centering dropped. */
  const line1 = (): string =>
    rendered(statusBarContent().split("\n")[0]).replace(/\{\/?center\}/g, "")

  function withWidth(cols: number, fn: () => void): void {
    const original = program.cols
    program.cols = cols
    try {
      fn()
    } finally {
      program.cols = original
      dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
    }
  }

  const longError = {
    provider: "buildkite",
    level: "error" as const,
    message:
      "Buildkite: HTTP 500 from /organizations/acme/pipelines/site-content-usm/builds?per_page=20",
  }

  test("at 80 columns line 1 fits, with the error truncated to what is left", () => {
    withWidth(80, () => {
      const runs = [
        makeRun({ status: "running" }),
        makeRun({ id: "2", key: "k2", status: "blocked" }),
      ]
      dashboard.updateWorkflows(runs, new Map(), undefined, undefined, [longError])

      const line = line1()
      expect(line.length).toBeLessThanOrEqual(78)
      expect(line).toContain("⚠")
    })
  })

  test("at 50 columns line 1 still fits, and the error collapses to a count", () => {
    withWidth(50, () => {
      const runs = [
        makeRun({ status: "running" }),
        makeRun({ id: "2", key: "k2", status: "blocked" }),
      ]
      dashboard.updateWorkflows(runs, new Map(), undefined, undefined, [longError, longError])

      const line = line1()
      expect(line.length).toBeLessThanOrEqual(48)
      expect(line).toContain("⚠ 2 errors")
      expect(line).not.toContain("HTTP 500")
    })
  })
})

describe("budget segment", () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0)
  const at = (ms: number): string =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const budget = (partial: Partial<Budget> = {}): Budget => ({
    provider: "github",
    limit: 5000,
    remaining: 4489,
    resetAt: now + 30 * 60_000,
    stretched: false,
    ...partial,
  })

  test("shows remaining over limit and the reset time", () => {
    expect(budgetSegment(budget(), undefined, now)).toBe(
      ` | GH 4489/5000 · resets ${at(now + 30 * 60_000)}`,
    )
  })

  test("a low budget is yellow and says slow", () => {
    expect(budgetSegment(budget({ remaining: 230, stretched: true }), undefined, now)).toBe(
      " | {yellow-fg}GH slow (budget low) 230/5000{/yellow-fg}",
    )
  })

  test("a pause is red and names the time", () => {
    const pausedUntil = now + 10 * 60_000
    expect(
      budgetSegment(budget({ pausedUntil, stretched: true }), { mode: "shared", message: "" }, now),
    ).toBe(` | {red-fg}GH paused until ${at(pausedUntil)}{/red-fg}`)
  })

  test("an expired pause is ignored", () => {
    expect(budgetSegment(budget({ pausedUntil: now - 1 }), undefined, now)).toContain("GH 4489")
  })

  test("in-process mode is appended", () => {
    const status = { mode: "in-process" as const, message: "" }
    expect(budgetSegment(budget(), status, now)).toEndWith(" | poller: in-process")
    expect(budgetSegment(undefined, status, now)).toBe(" | poller: in-process")
  })

  test("no budget and shared mode renders nothing", () => {
    expect(budgetSegment(undefined, undefined, now)).toBe("")
    expect(budgetSegment(undefined, { mode: "shared", message: "" }, now)).toBe("")
    expect(budgetSegment(budget({ limit: 0 }), undefined, now)).toBe("")
  })

  test("setBudget and setPollerStatus update the status line", () => {
    const d = dashboard as unknown as { lastStatusLine1: string }
    dashboard.setBudget(budget())
    expect(d.lastStatusLine1).toContain("GH 4489/5000")
    dashboard.setPollerStatus({ mode: "in-process", message: "" })
    expect(d.lastStatusLine1).toContain("poller: in-process")
    dashboard.setBudget(undefined)
    dashboard.setPollerStatus({ mode: "shared", message: "" })
    expect(d.lastStatusLine1).not.toContain("GH")
  })
})

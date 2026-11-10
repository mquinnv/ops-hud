import { beforeEach, describe, expect, test } from "bun:test"
import type { BuildkiteProviderOptions } from "../providers/buildkite.js"
import type { CiReader, FetchResult, ProviderDiagnostic, Scope } from "../providers/types.js"
import type { Job, Run } from "../types.js"
import { RateBudget } from "./budget.js"
import { type CoreDeps, PollerCore, REFRESH_DEBOUNCE_MS } from "./core.js"
import type { RepoState } from "./github-poller.js"
import type { Budget, Snapshot, Subscription } from "./protocol.js"

let t = 0
const now = () => t

function run(repo: string, id: string, createdAt: string, extra: Partial<Run> = {}): Run {
  const [owner, name] = repo.split("/")
  const provider = extra.provider ?? "github"
  return {
    provider,
    key: `${provider}:${repo}:${id}`,
    id,
    number: 1,
    title: id,
    pipeline: "ci",
    branch: "main",
    sha: "abc",
    status: "passed",
    isFailing: false,
    repo: { owner, name, fullName: repo },
    webUrl: `https://example.test/${id}`,
    createdAt,
    ...extra,
  }
}

function job(runKey: string, id: string): Job {
  return { id, key: `${runKey}:${id}`, runKey, name: id, status: "passed" }
}

class FakeGitHubPoller {
  readonly budget = new RateBudget(now)
  readonly polls: string[] = []
  readonly forgotten: string[] = []
  readonly olderCalls: { repositories: string[]; before: string; limit: number }[] = []
  readonly states = new Map<string, RepoState>()
  readonly active = new Set<string>()
  /** When set, poll() waits for this before resolving. */
  gate?: Promise<void>
  failWith?: Error

  async poll(repo: string): Promise<{ changed: boolean }> {
    this.polls.push(repo)
    if (this.gate) await this.gate
    if (this.failWith) throw this.failWith
    return { changed: true }
  }

  state(repo: string): RepoState | undefined {
    return this.states.get(repo)
  }

  isActive(repo: string): boolean {
    return this.active.has(repo)
  }

  forget(repo: string): void {
    this.forgotten.push(repo)
    this.states.delete(repo)
  }

  async fetchOlder(repositories: string[], before: string, limit: number): Promise<FetchResult> {
    this.olderCalls.push({ repositories, before, limit })
    return { runs: [run(repositories[0], "old", "2020-01-01T00:00:00Z")], diagnostics: [] }
  }

  pollsOf(repo: string): number {
    return this.polls.filter((r) => r === repo).length
  }
}

class FakeBuildkite implements CiReader {
  readonly name = "buildkite"
  readonly scopes: Scope[] = []
  result: FetchResult = { runs: [], diagnostics: [] }

  constructor(readonly opts: BuildkiteProviderOptions) {}

  async fetchRuns(scope: Scope): Promise<FetchResult> {
    this.scopes.push(scope)
    return this.result
  }

  async fetchJobs(): Promise<Job[]> {
    return []
  }
}

let github: FakeGitHubPoller
let readers: FakeBuildkite[]
let core: PollerCore
let snapshots: { clientId: string; snapshot: Snapshot }[]
let budgets: Budget[]

beforeEach(() => {
  t = 0
  github = new FakeGitHubPoller()
  readers = []
  snapshots = []
  budgets = []
  const deps: CoreDeps = {
    github,
    buildkiteFactory: (opts) => {
      const reader = new FakeBuildkite(opts)
      readers.push(reader)
      return reader
    },
    now,
  }
  core = new PollerCore(deps)
  core.onSnapshot((clientId, snapshot) => snapshots.push({ clientId, snapshot }))
  core.onBudget((budget) => budgets.push(budget))
})

const sub = (repositories: string[], extra: Partial<Subscription> = {}): Subscription => ({
  repositories,
  interval: 5_000,
  github: true,
  ...extra,
})

const snapshotsFor = (clientId: string) =>
  snapshots.filter((s) => s.clientId === clientId).map((s) => s.snapshot)
const last = (clientId: string) => snapshotsFor(clientId).at(-1)
const ids = (snapshot: Snapshot | undefined) => (snapshot?.runs ?? []).map((r) => r.id)

/** Advance the clock in 1s steps, ticking each time, as setInterval would. */
async function runFor(ms: number) {
  const end = t + ms
  while (t < end) {
    t += 1_000
    await core.tick()
  }
}

function setState(repo: string, runs: Run[], jobs: [string, Job[]][] = []) {
  github.states.set(repo, { runs, jobs: new Map(jobs), diagnostics: [] })
}

function limitHeaders(remaining: number, extra: Record<string, string> = {}) {
  return new Headers({
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": "100000",
    ...extra,
  })
}

test("subscribe emits an initial snapshot for that client", () => {
  setState("o/a", [run("o/a", "1", "2024-01-01T00:00:00Z")])
  core.subscribe("c1", sub(["o/a"]))
  expect(snapshotsFor("c1")).toHaveLength(1)
  const snap = snapshotsFor("c1")[0]
  expect(snap.repositories).toEqual(["o/a"])
  expect(ids(snap)).toEqual(["1"])
  expect(snap.budget).toBeDefined()
  expect(core.clientCount).toBe(1)
})

test("two clients on one repo cause one poll per tick", async () => {
  github.active.add("o/a")
  core.subscribe("c1", sub(["o/a"]))
  core.subscribe("c2", sub(["o/a"]))
  await core.tick()
  expect(github.pollsOf("o/a")).toBe(1)
  t += 5_000
  await core.tick()
  expect(github.pollsOf("o/a")).toBe(2)
})

test("each client gets only its own repositories", async () => {
  const a = run("o/a", "a1", "2024-01-01T00:00:00Z")
  const b = run("o/b", "b1", "2024-01-02T00:00:00Z")
  setState("o/a", [a], [[a.key, [job(a.key, "j")]]])
  setState("o/b", [b], [[b.key, [job(b.key, "j")]]])
  core.subscribe("c1", sub(["o/a"]))
  core.subscribe("c2", sub(["o/a", "o/b"]))
  await core.tick()
  expect(ids(last("c1"))).toEqual(["a1"])
  expect(Object.keys(last("c1")?.jobs ?? {})).toEqual([a.key])
  expect(ids(last("c2"))).toEqual(["b1", "a1"]) // newest first
  expect(Object.keys(last("c2")?.jobs ?? {}).sort()).toEqual([a.key, b.key])
})

test("a client is told again only when its view changed", async () => {
  github.active.add("o/a")
  core.subscribe("c1", sub(["o/a"]))
  await core.tick()
  const before = snapshotsFor("c1").length
  t += 5_000
  await core.tick()
  expect(snapshotsFor("c1")).toHaveLength(before)
  setState("o/a", [run("o/a", "1", "2024-01-01T00:00:00Z")])
  t += 5_000
  await core.tick()
  expect(snapshotsFor("c1")).toHaveLength(before + 1)
})

test("the fastest subscribed interval wins, floored at 5s", async () => {
  github.active.add("o/a")
  core.subscribe("c1", sub(["o/a"], { interval: 5_000 }))
  core.subscribe("c2", sub(["o/a"], { interval: 30_000 }))
  await core.tick()
  await runFor(10_000)
  expect(github.pollsOf("o/a")).toBe(3) // 0, 5s, 10s

  github.polls.length = 0
  core.subscribe("c1", sub(["o/a"], { interval: 1_000 }))
  core.subscribe("c2", sub(["o/a"], { interval: 1_000 }))
  await runFor(10_000)
  expect(github.pollsOf("o/a")).toBe(2) // 15s and 20s, not every second
})

test("when the fast client leaves the repo slows to the slow client's interval", async () => {
  github.active.add("o/a")
  core.subscribe("fast", sub(["o/a"], { interval: 5_000 }))
  core.subscribe("slow", sub(["o/a"], { interval: 30_000 }))
  await core.tick()
  await runFor(5_000)
  expect(github.pollsOf("o/a")).toBe(2)
  core.unsubscribe("fast")
  github.polls.length = 0
  await runFor(29_000) // last poll at 5s, so next is due at 35s
  expect(github.pollsOf("o/a")).toBe(0)
  await runFor(1_000)
  expect(github.pollsOf("o/a")).toBe(1)
  expect(github.forgotten).toEqual([])
})

test("a repo nobody watches is forgotten and never polled again", async () => {
  core.subscribe("c1", sub(["o/a"]))
  await core.tick()
  core.unsubscribe("c1")
  expect(github.forgotten).toEqual(["o/a"])
  expect(core.clientCount).toBe(0)
  github.polls.length = 0
  await runFor(60_000)
  expect(github.polls).toEqual([])
})

test("an idle repo is polled every 15s, an active one every interval", async () => {
  github.active.add("busy/r")
  core.subscribe("c1", sub(["idle/r", "busy/r"], { interval: 5_000 }))
  await core.tick()
  await runFor(30_000)
  expect(github.pollsOf("idle/r")).toBe(3) // 0, 15, 30
  expect(github.pollsOf("busy/r")).toBe(7) // 0, 5, ..., 30
})

test("a stretched budget multiplies the tick by 4", async () => {
  github.budget.record(limitHeaders(100))
  expect(github.budget.stretched).toBe(true)
  github.active.add("o/a")
  core.subscribe("c1", sub(["o/a"], { interval: 5_000 }))
  await core.tick()
  await runFor(19_000)
  expect(github.pollsOf("o/a")).toBe(1)
  await runFor(1_000)
  expect(github.pollsOf("o/a")).toBe(2) // 20s = 5s × 4
})

test("a paused budget polls nothing until pausedUntil", async () => {
  github.budget.recordLimitHit(limitHeaders(0, { "retry-after": "30" }))
  expect(github.budget.paused).toBe(true)
  core.subscribe("c1", sub(["o/a"]))
  await core.tick()
  await runFor(29_000)
  expect(github.polls).toEqual([])
  await runFor(1_000)
  expect(github.pollsOf("o/a")).toBe(1)
})

test("budget is broadcast when it changes and omitted from change detection", async () => {
  core.subscribe("c1", sub(["o/a"]))
  await core.tick()
  const budgetsBefore = budgets.length
  const snapsBefore = snapshotsFor("c1").length
  github.budget.record(limitHeaders(4_000))
  t += 5_000
  await core.tick()
  expect(budgets).toHaveLength(budgetsBefore + 1)
  expect(budgets.at(-1)?.remaining).toBe(4_000)
  // the view did not change, so no snapshot despite the new budget
  expect(snapshotsFor("c1")).toHaveLength(snapsBefore)
  t += 5_000
  await core.tick()
  expect(budgets).toHaveLength(budgetsBefore + 1)
})

test("a pane joining an established poller gets the current budget in its first snapshot", async () => {
  core.subscribe("c1", sub(["o/a"]))
  github.budget.record(limitHeaders(4_000))
  await core.tick()
  const budgetsBefore = budgets.length
  core.subscribe("c2", sub(["o/a"]))
  // No budget broadcast (nothing changed), so the snapshot is c2's only carrier.
  expect(budgets).toHaveLength(budgetsBefore)
  expect(snapshotsFor("c2")).toHaveLength(1)
  expect(snapshotsFor("c2")[0].budget?.remaining).toBe(4_000)
  expect(snapshotsFor("c2")[0].budget?.limit).toBe(5_000)
})

test("each repo poll logs the next tick it was given", async () => {
  const lines: string[] = []
  const logged = new PollerCore({
    github,
    buildkiteFactory: (opts) => new FakeBuildkite(opts),
    now,
    log: (line) => lines.push(line),
  })
  github.active.add("busy/r")
  logged.subscribe("c1", sub(["idle/r", "busy/r"], { interval: 5_000 }))
  await logged.tick()
  expect(lines.sort()).toEqual(["tick busy/r next=5000", "tick idle/r next=15000"])
})

test("refresh polls now, at most once per 2s per repo", async () => {
  core.subscribe("c1", sub(["o/a", "o/b"], { interval: 60_000 }))
  await core.tick()
  expect(github.polls).toEqual(["o/a", "o/b"])
  t += 1_000
  await core.refresh("c1", ["o/a"])
  expect(github.pollsOf("o/a")).toBe(2)
  expect(github.pollsOf("o/b")).toBe(1)
  t += 1_000
  await core.refresh("c1")
  expect(github.pollsOf("o/a")).toBe(2) // refreshed 1s ago
  expect(github.pollsOf("o/b")).toBe(2)
  t += REFRESH_DEBOUNCE_MS
  await core.refresh("c1")
  expect(github.pollsOf("o/a")).toBe(3)
  // ignores the tick but not the pause
  github.budget.recordLimitHit(limitHeaders(0, { "retry-after": "60" }))
  t += REFRESH_DEBOUNCE_MS
  await core.refresh("c1")
  expect(github.pollsOf("o/a")).toBe(3)
})

test("github: false subscribes the repos to Buildkite derivation only", async () => {
  setState("o/a", [run("o/a", "1", "2024-01-01T00:00:00Z")])
  core.subscribe("c1", sub(["o/a"], { github: false, buildkite: { token: "bk" } }))
  await core.tick()
  await runFor(30_000)
  await core.refresh("c1")
  expect(github.polls).toEqual([])
  expect(last("c1")?.runs).toEqual([])
  expect(readers).toHaveLength(1)
  expect(readers[0].scopes[0]).toEqual({ repositories: ["o/a"], pipelines: [] })
})

test("an in-flight poll of a repo is not started again by the next tick", async () => {
  let release = () => {}
  github.gate = new Promise((resolve) => {
    release = resolve
  })
  core.subscribe("c1", sub(["o/a"]))
  const first = core.tick()
  t += 10_000
  await core.tick()
  await core.refresh("c1")
  expect(github.pollsOf("o/a")).toBe(1)
  release()
  await first
  github.gate = undefined
  // the skipped refresh did not count toward its debounce
  await core.refresh("c1")
  expect(github.pollsOf("o/a")).toBe(2)
})

test("an unwatch and rewatch during a poll neither polls twice nor forgets the repo", async () => {
  let release = () => {}
  github.gate = new Promise((resolve) => {
    release = resolve
  })
  github.active.add("o/a")
  core.subscribe("c1", sub(["o/a"]))
  const first = core.tick()
  core.unsubscribe("c1")
  expect(github.forgotten).toEqual(["o/a"])
  core.subscribe("c2", sub(["o/a"]))
  await core.tick()
  expect(github.pollsOf("o/a")).toBe(1)
  setState("o/a", [run("o/a", "1", "2024-01-01T00:00:00Z")])
  release()
  await first
  github.gate = undefined
  expect(github.forgotten).toEqual(["o/a"])
  expect(ids(last("c2"))).toEqual(["1"])
})

test("a throwing snapshot listener does not reject tick() nor starve other listeners", async () => {
  const errors: unknown[] = []
  const quiet = new PollerCore({
    github,
    buildkiteFactory: (opts) => new FakeBuildkite(opts),
    now,
    onError: (error) => errors.push(error),
  })
  const received: Snapshot[] = []
  quiet.onSnapshot(() => {
    throw new Error("listener broke")
  })
  quiet.onSnapshot((_id, snapshot) => received.push(snapshot))
  quiet.onBudget(() => {
    throw new Error("budget listener broke")
  })
  github.active.add("o/a")
  quiet.subscribe("c1", sub(["o/a"]))
  expect(received).toHaveLength(1)
  setState("o/a", [run("o/a", "1", "2024-01-01T00:00:00Z")])
  github.budget.record(limitHeaders(4_000))
  await expect(quiet.tick()).resolves.toBeUndefined()
  expect(received).toHaveLength(2)
  expect(ids(received[1])).toEqual(["1"])
  expect(errors.length).toBeGreaterThanOrEqual(3)
})

test("a poll that throws becomes a diagnostic and does not reject tick()", async () => {
  github.active.add("o/a")
  github.failWith = new Error("boom")
  core.subscribe("c1", sub(["o/a"]))
  await expect(core.tick()).resolves.toBeUndefined()
  expect(last("c1")?.diagnostics).toEqual([
    { provider: "github", level: "error", message: "GitHub: boom", repository: "o/a" },
  ])
  github.failWith = undefined
  t += 5_000
  await core.tick()
  expect(last("c1")?.diagnostics).toEqual([])
})

describe("buildkite", () => {
  const bk = (repo: string, id: string, slug: string) =>
    run(repo, id, "2024-01-01T00:00:00Z", { provider: "buildkite", pipelineSlug: slug })

  test("one instance per token+org, scoped to the union", async () => {
    core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk", org: "acme" } }))
    core.subscribe("c2", sub(["o/b"], { buildkite: { token: "bk", org: "acme" } }))
    await core.tick()
    expect(readers).toHaveLength(1)
    expect(readers[0].opts).toEqual({ token: "bk", org: "acme" })
    expect(readers[0].scopes).toEqual([{ repositories: ["o/a", "o/b"], pipelines: [] }])
    // its own tick: max(15s, interval), no budget multiplier
    await runFor(14_000)
    expect(readers[0].scopes).toHaveLength(1)
    await runFor(1_000)
    expect(readers[0].scopes).toHaveLength(2)
  })

  test("a client with explicit pipelines contributes slugs, not repositories", async () => {
    core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk" } }))
    core.subscribe("c2", sub(["o/b"], { buildkite: { token: "bk", pipelines: ["deploy"] } }))
    await core.tick()
    expect(readers[0].scopes[0]).toEqual({ repositories: ["o/a"], pipelines: ["deploy"] })
  })

  test("each client sees only its own pipelines' builds", async () => {
    core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk", pipelines: ["p1"] } }))
    core.subscribe("c2", sub(["o/b"], { buildkite: { token: "bk", pipelines: ["p2"] } }))
    core.subscribe("c3", sub(["o/b"], { buildkite: { token: "bk" } }))
    const x = bk("o/a", "x", "p1")
    readers[0].result = {
      runs: [x, bk("o/b", "y", "p2"), bk("o/b", "z", "p3")],
      jobs: new Map([[x.key, [job(x.key, "j")]]]),
      diagnostics: [],
    }
    await core.tick()
    expect(ids(last("c1"))).toEqual(["x"])
    expect(Object.keys(last("c1")?.jobs ?? {})).toEqual([x.key])
    expect(ids(last("c2"))).toEqual(["y"])
    expect(last("c2")?.jobs).toEqual({})
    expect(ids(last("c3")).sort()).toEqual(["y", "z"])
  })

  test("an unscoped client makes the instance org-wide and sees everything", async () => {
    core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk" } }))
    core.subscribe("all", sub([], { buildkite: { token: "bk" } }))
    readers[0].result = { runs: [bk("o/a", "x", "p1"), bk("o/b", "y", "p2")], diagnostics: [] }
    await core.tick()
    expect(readers[0].scopes[0]).toEqual({ repositories: [], pipelines: [] })
    expect(ids(last("all")).sort()).toEqual(["x", "y"])
    expect(ids(last("c1"))).toEqual(["x"])
  })

  test("a repo-level diagnostic reaches only the client that watches that repo", async () => {
    core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk", org: "acme" } }))
    core.subscribe("c2", sub(["o/b"], { buildkite: { token: "bk", org: "acme" } }))
    const repoDiag: ProviderDiagnostic = {
      provider: "buildkite",
      level: "info",
      message: "Buildkite: no pipeline in acme builds o/a",
      repository: "o/a",
    }
    const general: ProviderDiagnostic = { provider: "buildkite", level: "error", message: "x" }
    readers[0].result = { runs: [], diagnostics: [repoDiag, general, { ...general }] }
    await core.tick()
    expect(last("c1")?.diagnostics).toEqual([repoDiag, general])
    expect(last("c2")?.diagnostics).toEqual([general])
  })

  test("an instance with no subscribers is dropped", async () => {
    core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk" } }))
    await core.tick()
    core.unsubscribe("c1")
    await runFor(60_000)
    expect(readers[0].scopes).toHaveLength(1)
    core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk" } }))
    expect(readers).toHaveLength(2) // a fresh instance, not the dropped one
  })

  test("a fetchRuns that throws becomes a diagnostic for its clients", async () => {
    core.subscribe("c1", sub(["o/a"], { github: false, buildkite: { token: "bk" } }))
    readers[0].fetchRuns = async () => {
      throw new Error("down")
    }
    await expect(core.tick()).resolves.toBeUndefined()
    expect(last("c1")?.diagnostics).toEqual([
      { provider: "buildkite", level: "error", message: "Buildkite: down" },
    ])
  })
})

test("older goes to GitHub only", async () => {
  core.subscribe("c1", sub(["o/a"], { buildkite: { token: "bk" } }))
  const result = await core.older(["o/a"], "2024-01-01T00:00:00Z", 10)
  expect(github.olderCalls).toEqual([
    { repositories: ["o/a"], before: "2024-01-01T00:00:00Z", limit: 10 },
  ])
  expect(result.runs.map((r) => r.id)).toEqual(["old"])
  expect(readers[0].scopes).toEqual([])
})

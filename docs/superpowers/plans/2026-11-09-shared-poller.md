# Shared Poller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One background poller per machine fetches CI state for every ops-hud pane, with conditional requests, adaptive ticks and budget-aware backoff, so GitHub traffic is bounded by the number of distinct repositories rather than the number of panes.

**Architecture:** A `PollerCore` (pure scheduler + snapshot builder) wraps a new `GitHubPoller` (direct `fetch` with ETags and rate-limit headers) and the existing `BuildkiteProvider`. `PollerServer` exposes the core over a Unix socket as NDJSON; `SocketPollerClient` in each pane connects, spawns the poller if absent, and falls back to an `InProcessPollerClient` around the same core. `App` keeps its tracking logic but consumes snapshots instead of fetching.

**Tech Stack:** TypeScript (ES2022, ESM), Bun for tests/dev, Node ≥18 at runtime, `node:net` Unix sockets, global `fetch`, `execa` only for `gh auth token` and the existing write actions. Biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-11-09-shared-poller-design.md`

## Global Constraints

- Node 18+ at runtime: no Bun-only APIs in `src/` (tests may use `bun:test`).
- No live network and no blessed in tests; every HTTP, clock, spawn and socket-path dependency is injected.
- Every GitHub request carries `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, and `If-None-Match` when an ETag is held; 30s timeout; at most 4 in flight.
- Tokens go only to `https://api.github.com` (GitHub) and `https://api.buildkite.com/` (Buildkite, already enforced).
- Socket path: `$OPS_HUD_POLLER_SOCKET`, else `$XDG_CACHE_HOME/ops-hud/poller-<version>[-dev].sock`, else `~/.cache/ops-hud/...`; directory mode `0700`; `-dev` when the entry script ends in `.ts`.
- Ticks: active = subscribed interval (min across panes, floor 5000ms); idle = 15000ms; budget-low = 4× (remaining < max(300, 10% of limit)); paused = until reset / retry-after / 60s.
- Poller exits 60s after its last client disconnects, or when its socket file is gone (checked every 60s). Never exits because of GitHub auth.
- Client startup: connect; unlink socket only if its mtime is >5s old; spawn detached; retry every 100ms for 3s; then in-process fallback that retries the socket every 30s.
- PR header polls every 30s; Docker status every `refreshInterval`.
- Version bump to 2.1.0; all `gh api` calls on the read path are removed.
- Run `bun run check` (Biome) and `bun test` before every commit; both must pass.

## Review Focus

1. **A repository the token cannot read (403 without rate-limit wording, or 404).** Expected: a per-repo error diagnostic naming the repo; no pause; other repos keep polling. Test in Task 3.
2. **`x-ratelimit-reset` in the past, or `retry-after: 0`.** Expected: the poller is not paused at all rather than paused forever. Test in Task 2.
3. **Two panes on one repo at different intervals, then the faster one leaves.** Expected: polled at 5s while both are present, at 30s after, and a repo nobody watches is forgotten and never polled again. Test in Task 5.
4. **A garbage line on the socket (not JSON, or JSON without `type`).** Expected: the line is dropped and logged; the connection and the poller survive. Test in Task 6.
5. **`connect()` fails with `EACCES` or the cache directory cannot be created.** Expected: no spawn loop and no crash; the pane goes in-process and says so. Test in Task 7.

---

### Task 1: Protocol, framing and socket path

**Files:**
- Create: `src/poller/protocol.ts`
- Test: `src/poller/protocol.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BuildkiteSubscription { token: string; org?: string; pipelines?: string[] }
  export interface Subscription {
    repositories: string[]
    /** ms; the poller floors it at MIN_INTERVAL_MS */
    interval: number
    /** false = --no-github: repositories are used for Buildkite derivation only */
    github: boolean
    buildkite?: BuildkiteSubscription
  }
  export interface Budget {
    provider: "github"
    limit: number
    remaining: number
    /** epoch ms */
    resetAt: number
    /** epoch ms, present only while paused */
    pausedUntil?: number
    stretched: boolean
  }
  export interface Snapshot {
    repositories: string[]
    runs: Run[]
    /** keyed by Run.key; a plain object because it crosses JSON */
    jobs: Record<string, Job[]>
    diagnostics: ProviderDiagnostic[]
    budget?: Budget
  }
  export type PaneMessage =
    | { type: "hello"; version: string; pid: number }
    | { type: "watch"; subscription: Subscription }
    | { type: "refresh"; repositories?: string[] }
    | { type: "older"; id: string; repositories: string[]; before: string; limit: number }
  export type PollerMessage =
    | { type: "snapshot"; snapshot: Snapshot }
    | { type: "budget"; budget: Budget }
    | { type: "older-result"; id: string; runs: Run[]; diagnostics: ProviderDiagnostic[] }
  export const MIN_INTERVAL_MS = 5_000
  export const IDLE_INTERVAL_MS = 15_000
  export function encode(message: PaneMessage | PollerMessage): string  // one line + "\n"
  /** Splits a buffer on "\n", returning parsed messages (unparseable lines reported) and the unconsumed tail. */
  export function decodeLines(buffer: string): { messages: unknown[]; bad: string[]; rest: string }
  export function isPaneMessage(value: unknown): value is PaneMessage
  export function isPollerMessage(value: unknown): value is PollerMessage
  export function socketPath(opts: { env: Record<string, string | undefined>; version: string; entryScript: string; home: string }): string
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("encode produces one line per message", ...)       // ends with "\n", no inner newlines
test("decodeLines returns complete messages and keeps the partial tail", ...)
  // input '{"type":"refresh"}\n{"type":"he' → messages.length 1, rest '{"type":"he'
test("decodeLines reports a line that is not JSON, and one with no type, as bad", ...)
test("isPaneMessage rejects a poller message and vice versa", ...)
test("socketPath honors OPS_HUD_POLLER_SOCKET outright", ...)
test("socketPath uses XDG_CACHE_HOME when set, else ~/.cache", ...)
  // version "2.1.0", entry "dist/index.js" → ".../ops-hud/poller-2.1.0.sock"
test("socketPath adds -dev when the entry script is a .ts file", ...)
  // entry "src/index.ts" → "poller-2.1.0-dev.sock"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/poller/protocol.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/poller/protocol.ts`** with the interfaces above. `isPaneMessage`/`isPollerMessage` check `type` against the literal unions only; payload shape is trusted (same user, same machine).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/poller/protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/poller/protocol.ts src/poller/protocol.test.ts
git commit -m "feat(poller): wire protocol, NDJSON framing and socket path"
```

---

### Task 2: Rate budget

**Files:**
- Create: `src/poller/budget.ts`
- Test: `src/poller/budget.test.ts`

**Interfaces:**
- Consumes: `Budget` from Task 1.
- Produces:
  ```ts
  export const LOW_FRACTION = 0.1
  export const LOW_FLOOR = 300
  export const STRETCH_FACTOR = 4
  export const DEFAULT_PAUSE_MS = 60_000
  export class RateBudget {
    constructor(now: () => number = Date.now)
    /** Any response: reads x-ratelimit-limit/-remaining/-reset (epoch seconds). Missing headers leave the previous values. */
    record(headers: Headers): void
    /** A 403/429 that is a rate limit. Pause until retry-after (s), else reset when remaining is 0, else DEFAULT_PAUSE_MS. */
    recordLimitHit(headers: Headers): void
    get paused(): boolean          // pausedUntil > now
    get stretched(): boolean       // remaining < max(LOW_FLOOR, LOW_FRACTION * limit)
    multiplier(): number           // STRETCH_FACTOR when stretched, else 1 (paused is handled by the scheduler)
    snapshot(): Budget
  }
  /** True for a 429, or a 403 whose body or headers say rate limit. */
  export function isRateLimitResponse(status: number, headers: Headers, bodyText: string): boolean
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("record reads the three headers", ...)          // limit 5000, remaining 4489, resetAt = reset*1000
test("unknown budget is neither stretched nor paused", ...)   // before any record()
test("stretched below 10% of the limit, and below 300 regardless of limit", ...)
  // limit 5000 remaining 499 → stretched; limit 1000 remaining 299 → stretched; limit 1000 remaining 301 → not
test("a 429 with retry-after pauses for that many seconds", ...)
test("a 403 with remaining 0 pauses until reset", ...)
test("a hit with neither pauses for 60s", ...)
test("a reset in the past does not pause", ...)      // Review Focus 2
test("retry-after 0 does not pause", ...)             // Review Focus 2
test("isRateLimitResponse: 429 yes; 403 'API rate limit exceeded' yes; 403 'Resource not accessible' no", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/poller/budget.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/poller/budget.ts`**. `isRateLimitResponse` uses `/rate limit/i` on the body, or `x-ratelimit-remaining === "0"`, for 403.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/poller/budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/poller/budget.ts src/poller/budget.test.ts
git commit -m "feat(poller): rate budget from GitHub's headers"
```

---

### Task 3: GitHubPoller — conditional requests, jobs, auth

**Files:**
- Create: `src/poller/github-poller.ts`
- Modify: `src/providers/github-map.ts:7-25` (add `run_attempt?: number` to `GitHubRunPayload`)
- Modify: `src/providers/types.ts:9-13` (add `repository?: string` to `ProviderDiagnostic`)
- Test: `src/poller/github-poller.test.ts` (uses `src/fixtures/github-runs.json`, `github-jobs.json`)

**Interfaces:**
- Consumes: `RateBudget`, `isRateLimitResponse` (Task 2); `mapGitHubRun`, `mapGitHubJob` (existing); `isActive`, `isTerminal` (existing `status.ts`).
- Produces:
  ```ts
  export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
  export type TokenResolver = () => Promise<string | undefined>
  /** GH_TOKEN, then GITHUB_TOKEN, then `gh auth token` (via the injected runner). */
  export function resolveGitHubToken(env: Record<string, string | undefined>, run: (file: string, args: string[]) => Promise<{ stdout: string }>): Promise<string | undefined>
  export interface RepoState { runs: Run[]; jobs: Map<string, Job[]>; diagnostics: ProviderDiagnostic[] }
  export const GITHUB_API = "https://api.github.com"
  export const MAX_IN_FLIGHT = 4
  export const TOKEN_RETRY_MS = 60_000
  export const RUNS_PER_PAGE = 20
  export class GitHubPoller {
    constructor(opts: { fetch?: FetchLike; now?: () => number; resolveToken: TokenResolver })
    readonly budget: RateBudget
    /** "ok" once a token resolved; "unauthenticated" before, and after a 401 until re-resolution succeeds. */
    get authState(): "ok" | "unauthenticated"
    /** Run list (conditional) then jobs for active runs (conditional) and once more for runs that just finished. Never throws. */
    poll(repo: string): Promise<{ changed: boolean }>
    state(repo: string): RepoState | undefined
    isActive(repo: string): boolean
    forget(repo: string): void
    /** `created=<before`, newest first, sliced to limit. Counted in the budget; respects pause. */
    fetchOlder(repositories: string[], before: string, limit: number): Promise<FetchResult>
  }
  ```

- [ ] **Step 1: Write the failing tests** (a `fakeFetch` records requests and answers from a queue of `{ status, headers, body }`)

```ts
describe("run list")
  test("sends bearer, accept and api-version headers to api.github.com", ...)
  test("a 200 maps the fixture and stores its ETag", ...)   // next poll sends If-None-Match: <etag>
  test("a 304 keeps the stored runs and reports changed: false", ...)
  test("a 200 with different content reports changed: true", ...)
describe("jobs")
  test("jobs are fetched for every active run, each with its own ETag", ...)
  test("jobs are not fetched for a run that was already finished when first seen", ...)
  test("a run that goes active→finished gets one more jobs fetch, then none", ...)
  test("a rerun (new run_attempt) is a new jobs key and is fetched again", ...)
describe("budget and errors")
  test("every response feeds the budget", ...)                 // budget.snapshot().remaining matches last header
  test("a 403 rate limit pauses and yields one 'GitHub: API rate limit exceeded' diagnostic", ...)
  test("while paused, poll() makes no request", ...)
  test("a 403 without rate-limit wording is a per-repo error diagnostic and does not pause", ...)  // Review Focus 1
  test("a 404 is a per-repo error diagnostic naming the repo, with diagnostic.repository set", ...) // Review Focus 1
  test("no more than 4 requests are in flight at once", ...)   // 10 active runs; fakeFetch counts concurrency
describe("auth")
  test("no token: authState is unauthenticated, no request goes out, diagnostic names gh auth login", ...)
  test("the token is re-resolved after TOKEN_RETRY_MS and polling resumes", ...)
  test("a 401 re-resolves once; if that fails the state is unauthenticated", ...)
  test("resolveGitHubToken prefers GH_TOKEN, then GITHUB_TOKEN, then gh auth token", ...)
describe("fetchOlder")
  test("asks for created=<before with per_page=limit and returns the newest first", ...)
  test("a rate limit yields the diagnostic instead of an empty result", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/poller/github-poller.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Add `run_attempt?: number` to `GitHubRunPayload` and `repository?: string` to `ProviderDiagnostic`.** Both optional; nothing existing changes.

- [ ] **Step 4: Implement `src/poller/github-poller.ts`.** Per-repo private state: `{ etag?, raw: GitHubRunPayload[], runs, jobs: Map<runKey, { etag?, attempt, jobs, final: boolean }>, diagnostics }`. Jobs key per run is `${run.id}:${run_attempt ?? 1}`; `final` is set after the fetch that follows an active→terminal transition. The in-flight cap is a small promise semaphore local to the module. Timeout via `AbortSignal.timeout(30_000)`. Diagnostics for request failures reuse the wording of today's `GitHubProvider.diagnose` ("GitHub: could not list runs for <repo> — <reason>", "GitHub: API rate limit exceeded") and set `repository`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/poller/github-poller.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/poller/github-poller.ts src/poller/github-poller.test.ts src/providers/github-map.ts src/providers/types.ts
git commit -m "feat(poller): GitHubPoller with ETags, job tracking and budget"
```

---

### Task 4: Buildkite provider takes its scope per call

**Files:**
- Modify: `src/providers/types.ts` (`Scope` gains `pipelines?: string[]`; `CiProvider` splits)
- Modify: `src/providers/buildkite.ts:192-230, 247-285` (`fetchRuns` scope handling, `scopeKey`, "no pipeline" diagnostic)
- Test: `src/providers/buildkite-config.test.ts` (append a `describe`)

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  /** The pane-side, user-initiated operations. Both providers implement this. */
  export interface CiProvider { readonly name: string; cancel(run: Run): Promise<void>; rerun(run: Run): Promise<void>; logs(run: Run): Promise<string> }
  /** The read path. Lives in the poller process. BuildkiteProvider implements it; GitHubProvider stops doing so in Task 9. */
  export interface CiReader { readonly name: string; fetchRuns(scope: Scope): Promise<FetchResult>; fetchJobs(run: Run): Promise<Job[]> }
  ```
  `fetchOlderRuns` is removed from the interface (only GitHub ever had it; the poller owns it now). `BuildkiteProvider implements CiProvider, CiReader`. Existing test doubles that implement both keep compiling.
- Produces: `Scope = { repositories: string[]; pipelines?: string[] }`. In `fetchRuns`: slugs = `(scope.pipelines ?? this.explicitPipelines)` ∪ `derived(scope.repositories)`; when both are empty, org-wide as before. A pane today passes only `repositories` with its explicit list in the constructor, so single-pane behavior is unchanged: the poller is responsible for *not* passing a pane's repositories when that pane has explicit slugs (Task 5). The "no pipeline in <org> builds <repo>" diagnostic sets `repository: repo`.

- [ ] **Step 1: Write the failing tests** (same `fetch` stub style as the existing file)

```ts
describe("per-call scope")
  test("scope.pipelines are fetched alongside slugs derived from scope.repositories", ...)
  test("scope.pipelines replaces the constructor's pipelines when both are given", ...)
  test("the 'no pipeline builds X' diagnostic carries repository: X", ...)
  test("the 15s cache key includes scope.pipelines, so a different pipeline set is a new fetch", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/providers/buildkite-config.test.ts`
Expected: the four new tests FAIL; the rest PASS.

- [ ] **Step 3: Implement** the interface split and the scope change in `fetchRuns`/`fetchRunsFromNetwork`; `scopeKey` = repositories + "|" + pipelines. `GitHubProvider` declares `implements CiProvider, CiReader` for now (Task 9 drops `CiReader`).

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/providers/buildkite.ts src/providers/buildkite-config.test.ts
git commit -m "feat(buildkite): accept pipelines per fetchRuns call"
```

---

### Task 5: PollerCore — subscriptions, ticks, snapshots

**Files:**
- Create: `src/poller/core.ts`
- Test: `src/poller/core.test.ts`

**Interfaces:**
- Consumes: `GitHubPoller` (Task 3; tests inject a fake with the same public surface), `BuildkiteProvider` via a factory `(opts: BuildkiteProviderOptions) => CiReader` (Task 4; tests inject a fake reader), `Subscription`/`Snapshot`/`Budget`/`MIN_INTERVAL_MS`/`IDLE_INTERVAL_MS` (Task 1), `RateBudget` (Task 2).
- Produces:
  ```ts
  export interface CoreDeps {
    github: GitHubPoller
    buildkiteFactory: (opts: BuildkiteProviderOptions) => CiReader
    now?: () => number
  }
  export class PollerCore {
    constructor(deps: CoreDeps)
    subscribe(clientId: string, subscription: Subscription): void   // replaces; emits a snapshot for this client right away (from current state)
    unsubscribe(clientId: string): void
    get clientCount(): number
    onSnapshot(cb: (clientId: string, snapshot: Snapshot) => void): void
    onBudget(cb: (budget: Budget) => void): void
    /** Polls everything due at `now()`; resolves when those polls finish. Tests drive this directly. */
    tick(): Promise<void>
    /** Immediate poll of these repos (default: the client's), ignoring the tick but not the pause; max once per 2s per repo. */
    refresh(clientId: string, repositories?: string[]): Promise<void>
    older(repositories: string[], before: string, limit: number): Promise<FetchResult>   // GitHub only
    /** setInterval(tick, 1000) / clearInterval, for production use. */
    start(): void
    stop(): void
  }
  ```
  Snapshot rules (one place, `buildSnapshot(clientId)`):
  - GitHub runs/jobs/diagnostics for the client's repositories, only when `subscription.github` is true.
  - Buildkite instances keyed by `${org ?? ""}\u0000${token}`; the instance's scope is `pipelines` = ∪ explicit slugs of its subscribers that have any, `repositories` = ∪ repositories of its subscribers that have no explicit slugs; if any subscriber has neither, both are empty (org-wide). A client's Buildkite runs: all of them if the client is unscoped; else `run.pipelineSlug ∈ client.pipelines` when the client has explicit slugs; else `run.repo.fullName ∈ client.repositories`.
  - Diagnostics pass if `!d.repository || client.repositories.includes(d.repository)`.
  - `runs` sorted newest first; `jobs` only for runs in the snapshot.
  - Emit only when `JSON.stringify({runs, jobs, diagnostics})` differs from the last string sent to that client; the `budget` field is attached but excluded from the comparison. `onBudget` fires whenever `budget.snapshot()` differs from the last one broadcast.
  Tick rules: per-repo `nextPollAt`; after a poll, next = now + (active ? minInterval : IDLE) × `budget.multiplier()`; nothing is polled while `budget.paused`. Buildkite instances have their own `nextPollAt` with tick `max(15_000, minInterval)` × 1.

- [ ] **Step 1: Write the failing tests** (fake clock `let t = 0; now = () => t`; `FakeGitHubPoller` records `poll()` calls and lets tests set `state`/`isActive`)

```ts
test("subscribe emits an initial snapshot for that client", ...)
test("two clients on one repo cause one poll per tick", ...)
test("each client gets only its own repositories", ...)
test("a client is told again only when its view changed", ...)   // tick with unchanged state → no second snapshot
test("the fastest subscribed interval wins, floored at 5s", ...)   // 5000 and 30000 → polled 5s apart; 1000 → 5000
test("when the fast client leaves the repo slows to the slow client's interval", ...)   // Review Focus 3
test("a repo nobody watches is forgotten and never polled again", ...)                   // Review Focus 3
test("an idle repo is polled every 15s, an active one every interval", ...)
test("a stretched budget multiplies the tick by 4", ...)
test("a paused budget polls nothing until pausedUntil", ...)
test("budget is broadcast when it changes and omitted from change detection", ...)
test("refresh polls now, at most once per 2s per repo", ...)
test("github: false subscribes the repos to Buildkite derivation only", ...)   // FakeGitHubPoller.poll never called
describe("buildkite")
  test("one instance per token+org, scoped to the union", ...)        // factory called once for two clients; fetchRuns scope has both repos
  test("a client with explicit pipelines contributes slugs, not repositories", ...)
  test("each client sees only its own pipelines' builds", ...)
  test("an unscoped client makes the instance org-wide and sees everything", ...)
  test("a repo-level diagnostic reaches only the client that watches that repo", ...)
  test("an instance with no subscribers is dropped", ...)
test("older goes to GitHub only", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/poller/core.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/poller/core.ts`** per the rules above. Buildkite results are stored per instance (`FetchResult`) and filtered per client at snapshot time.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/poller/core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/poller/core.ts src/poller/core.test.ts
git commit -m "feat(poller): scheduler, subscriptions and per-pane snapshots"
```

---

### Task 6: PollerServer, poller entry point and `__poller` command

**Files:**
- Create: `src/poller/server.ts`
- Create: `src/poller/main.ts`
- Modify: `src/cli.ts:361-375` (`buildProgram`: add hidden `__poller` command)
- Test: `src/poller/server.test.ts` (real `net` socket in a `mkdtempSync` dir)

**Interfaces:**
- Consumes: `PollerCore` (Task 5), protocol (Task 1).
- Produces:
  ```ts
  export const LINGER_MS = 60_000
  export const SOCKET_CHECK_MS = 60_000
  export interface ServerOptions {
    socketPath: string
    version: string
    lingerMs?: number
    socketCheckMs?: number
    log?: (line: string) => void
    /** Called instead of process.exit when the server decides to stop; tests observe it. */
    onIdle?: () => void
  }
  export class PollerServer {
    constructor(core: PollerCore, opts: ServerOptions)
    /** mkdir -p 0700 the directory; listen. Rejects with the EADDRINUSE error untouched. */
    listen(): Promise<void>
    /** Stops timers, ends clients, closes the server, unlinks the socket file. */
    close(): Promise<void>
  }
  ```
  `src/poller/main.ts` exports `runPoller(): Promise<void>`: builds `GitHubPoller` (real `fetch`, `resolveGitHubToken(process.env, execa)`), `PollerCore` with `(opts) => new BuildkiteProvider(opts)`, `PollerServer` with `log` appending to `<cache dir>/poller.log` (truncate when > 1 MB; one line per poll: time, repo, status, remaining, tick), `onIdle = () => process.exit(0)`; installs SIGTERM/SIGINT handlers calling `close()` then exit; on `EADDRINUSE` exits 0 silently. `cli.ts` registers `program.command("__poller", { hidden: true }).action(runPoller)`.

- [ ] **Step 1: Write the failing tests** (helper `connect(path)` returns a `net.Socket` plus an async line reader; fake clock for linger via injected `lingerMs: 50`)

```ts
test("hello with a matching version is accepted; a mismatch closes the connection", ...)
test("watch subscribes and the client receives a snapshot line", ...)
test("two clients watching one repo cause one core subscription per client and one github poll", ...)   // via FakeGitHubPoller
test("a client disconnect unsubscribes it", ...)                   // core.clientCount drops
test("the server calls onIdle lingerMs after the last client leaves, not before", ...)
test("a new client during the linger cancels it", ...)
test("a garbage line is logged and ignored; the next valid line still works", ...)   // Review Focus 4
test("listen() rejects with EADDRINUSE when another server holds the path", ...)
test("close() removes the socket file", ...)
test("the server stops when its socket file disappears", ...)        // socketCheckMs: 20; unlink; expect onIdle
test("older is answered with an older-result carrying the same id", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/poller/server.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `server.ts`, `main.ts`, and the hidden command.**

- [ ] **Step 4: Run tests, lint and a smoke start**

Run: `bun test src/poller/server.test.ts && bun run check`
Expected: PASS, no lint errors.
Run: `OPS_HUD_POLLER_SOCKET=/tmp/ops-hud-smoke.sock timeout 5 bun src/index.ts __poller; ls -la /tmp/ops-hud-smoke.sock || echo removed`
Expected: the process runs until the timeout; afterwards the socket file is removed (SIGTERM handler).

- [ ] **Step 5: Commit**

```bash
git add src/poller/server.ts src/poller/main.ts src/poller/server.test.ts src/cli.ts
git commit -m "feat(poller): socket server, log file and hidden __poller command"
```

---

### Task 7: Poller clients — socket with spawn/fallback/rejoin, and in-process

**Files:**
- Create: `src/poller/client.ts`
- Test: `src/poller/client.test.ts`

**Interfaces:**
- Consumes: protocol (Task 1), `PollerCore` (Task 5), `PollerServer` (Task 6, in tests only).
- Produces:
  ```ts
  export interface PollerStatus { mode: "shared" | "in-process"; pid?: number; message: string }
  export interface PollerClient {
    watch(subscription: Subscription): void
    refresh(repositories?: string[]): void
    older(repositories: string[], before: string, limit: number): Promise<FetchResult>
    onSnapshot(cb: (snapshot: Snapshot) => void): void
    onBudget(cb: (budget: Budget) => void): void
    onStatus(cb: (status: PollerStatus) => void): void
    close(): void
  }
  export class InProcessPollerClient implements PollerClient {
    constructor(core: PollerCore)   // subscribes as clientId "local"; calls core.start() on first watch; core.stop() on close
  }
  export const STARTUP_TIMEOUT_MS = 3_000
  export const RETRY_MS = 100
  export const REJOIN_MS = 30_000
  export const STALE_SOCKET_MS = 5_000
  export interface SocketClientOptions {
    socketPath: string
    version: string
    spawnPoller: () => void
    makeFallbackCore: () => PollerCore
    connect?: (path: string) => net.Socket
    now?: () => number
    startupTimeoutMs?: number
    retryMs?: number
    rejoinMs?: number
    staleSocketMs?: number
    /** mtime lookup, injectable; default fs.statSync */
    mtimeOf?: (path: string) => number | undefined
    unlink?: (path: string) => void
  }
  export class SocketPollerClient implements PollerClient {
    constructor(opts: SocketClientOptions)
    /** Runs the startup procedure; resolves once connected or once the fallback is in place. Never rejects. */
    start(): Promise<void>
  }
  /** Production wiring: socketPath() from env/version/argv, spawnPoller = spawn(process.execPath, [process.argv[1], "__poller"], { detached: true, stdio: "ignore" }).unref(). */
  export function createPollerClient(opts: { version: string }): SocketPollerClient
  ```
  Behavior: `watch` before connection is remembered and sent (after `hello`) on connect; after a drop, the procedure restarts from step 1 and the last snapshot is left in place; in in-process mode a rejoin attempt runs every `rejoinMs`, and on success the in-process core is stopped and `watch` is re-sent. Every mode change emits `onStatus`.

- [ ] **Step 1: Write the failing tests** (a real `PollerServer` with a `FakeGitHubPoller`-backed core in a tmp dir where a poller is wanted; `spawnPoller` is a spy that optionally starts that server; `connect` injectable to simulate `EACCES`)

```ts
test("connects to a running poller and forwards watch after hello", ...)
test("with no poller it spawns one, retries, and connects when it appears", ...)   // spawnPoller starts the server after 150ms
test("a stale socket file older than 5s is unlinked before spawning; a fresh one is not", ...)
test("falls back in-process after the startup timeout and reports mode in-process", ...)
test("an in-process client rejoins when the socket appears later", ...)          // status goes shared; core.stop() was called
test("EACCES on connect goes straight to in-process without a spawn loop", ...)   // Review Focus 5: spawnPoller called at most once
test("a dropped connection is retried and the client reconnects", ...)
test("older resolves with the matching older-result", ...)
test("InProcessPollerClient delivers snapshots from the core", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/poller/client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/poller/client.ts`.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/poller/client.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/poller/client.ts src/poller/client.test.ts
git commit -m "feat(poller): socket client with spawn, fallback and rejoin"
```

---

### Task 8: Dashboard — budget segment, spinner only on manual refresh

**Files:**
- Modify: `src/dashboard.ts:2017-2075` (`updateStatusBar`), plus new `setBudget`/`setPollerStatus`
- Test: `src/dashboard.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `Budget` (Task 1), `PollerStatus` (Task 7).
- Produces:
  ```ts
  // on Dashboard
  setBudget(budget: Budget | undefined): void
  setPollerStatus(status: PollerStatus): void
  /** Pure, exported for tests. */
  export function budgetSegment(budget: Budget | undefined, status: PollerStatus | undefined, now: number): string
  ```
  Copy: ` | GH 4489/5000 · resets 14:32` normally; `{yellow-fg}GH slow (budget low) 230/5000{/}` when `stretched`; `{red-fg}GH paused until 14:32{/red-fg}` when `pausedUntil > now`; append ` | poller: in-process` when `status.mode === "in-process"`. Times via `toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })`. The segment is appended to line 1 after the error segment and dropped when it does not fit. `updateWorkflows` no longer stops a spinner that `showLoadingInStatus` did not start (it still calls `stopRefreshAnimation`, which is a no-op when idle).

- [ ] **Step 1: Write the failing tests**

```ts
describe("budget segment")
  test("shows remaining over limit and the reset time", ...)
  test("a low budget is yellow and says slow", ...)
  test("a pause is red and names the time", ...)
  test("in-process mode is appended", ...)
  test("no budget and shared mode renders nothing", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/dashboard.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement** `budgetSegment`, the two setters (each calls `updateStatusBar`), and the status-bar wiring.

- [ ] **Step 4: Run the whole suite**

Run: `bun test && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.ts src/dashboard.test.ts
git commit -m "feat(dashboard): show the GitHub budget and poller mode"
```

---

### Task 9: App consumes snapshots; GitHubProvider loses its read path

**Files:**
- Modify: `src/app.ts` (constructor, `initialize`, `performRefresh` → `applySnapshot`, timers, `resurrectOldestRun`, action handlers' post-refresh)
- Modify: `src/providers/github.ts` (delete `fetchRuns`, `fetchJobs`, `fetchOlderRuns`, the cache, `limit`; keep the rest)
- Modify: `src/providers/github.ts` class declaration (drop `CiReader`; keep `CiProvider`)
- Test: `src/app.test.ts` (adapt), `src/providers/github.test.ts` (drop the fetchRuns/fetchJobs/fetchOlderRuns describes)

**Interfaces:**
- Consumes: `PollerClient`, `createPollerClient` (Task 7), `Snapshot`/`Budget`/`Subscription` (Task 1), `Dashboard.setBudget`/`setPollerStatus` (Task 8).
- Produces (on `App`):
  ```ts
  // AppDependencies gains:
  pollerClient?: PollerClient
  // App gains:
  applySnapshot(snapshot: Snapshot): void        // the tracking half of today's performRefresh, then updateWorkflows
  export const PR_REFRESH_MS = 30_000
  ```
  `initialize()` order: load config → build action providers (unchanged `buildProviders`) → repositories → `setupEventHandlers` → `pollerClient.onSnapshot(applySnapshot)`, `onBudget(dashboard.setBudget)`, `onStatus(status => { dashboard.setPollerStatus(status); dashboard.log(status.message, "info") })` → `await pollerClient.start?.()` → `pollerClient.watch({ repositories, interval: refreshInterval, github: !noGithub, buildkite })` where `buildkite` is the same `{ token, org, pipelines }` the factory received, omitted when `noBuildkite` or no token → start the PR timer (if `showPRs`) and Docker timer (if `showDocker`), each re-rendering with the last snapshot. The `r` key calls `pollerClient.refresh()` and `dashboard.showLoadingInStatus()`. Cancel/rerun handlers call `pollerClient.refresh([run.repo.fullName])` afterwards. `resurrectOldestRun` uses `pollerClient.older(repositories, before, 1)`; the cursor is the oldest GitHub run in the last snapshot. `stop()` closes the client and clears the timers.
  Test adaptation in `app.test.ts`: the `makeDashboard` double gains no-op `setBudget`/`setPollerStatus`; **every** `new App(...)` in the file passes `pollerClient: new FakePollerClient()` (the real client is constructed only when the dependency is absent, and it would spawn a process); `makeApp(providers)` builds a `FakePollerClient` and returns `refresh()` which assembles a `Snapshot` from the fake providers (calling their `fetchRuns`, embedding jobs, calling `fetchJobs` for active runs) and feeds `app.applySnapshot`. Replace `await internals.performRefresh()` with `await refresh()`; `olderResult` moves onto the fake client. The "a provider that cannot page backwards sits it out" and "resurrect cursor" tests become: cursor and `older` are GitHub-only.

- [ ] **Step 1: Adapt `app.test.ts`** as described, and delete the three read-path `describe`s from `github.test.ts`. Add:

```ts
test("the poller is told the repositories, interval and github flag", ...)        // fake client records watch()
test("--no-github sends github: false but still watches the repositories", ...)
test("a snapshot renders; an identical second snapshot still goes through tracking", ...)
test("budget messages reach the dashboard", ...)
test("r sends refresh to the poller", ...)
test("after a cancel the run's repo is refreshed through the poller", ...)
test("resurrect asks the poller for runs older than the oldest GitHub run", ...)
test("PRs are fetched on their own 30s timer, not per snapshot", ...)   // fake timers via injected setInterval? Use `deps.now` plus an exposed `pollPullRequests()`; assert `getAllPullRequests` is not called by applySnapshot
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/app.test.ts src/providers/github.test.ts`
Expected: FAIL (compile errors on `applySnapshot`, `pollerClient`).

- [ ] **Step 3: Implement** the `App` changes and the `GitHubProvider` deletions. `App` must not import `PollerCore`/`GitHubPoller` directly except through `createPollerClient`.

- [ ] **Step 4: Run the whole suite and lint**

Run: `bun test && bun run check && bun run build`
Expected: PASS, clean, compiles.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/app.test.ts src/providers/github.ts src/providers/github.test.ts
git commit -m "feat(app): consume poller snapshots instead of fetching"
```

---

### Task 10: README, version, live verification

**Files:**
- Modify: `README.md` (new "How polling works" section after "What shows on the grid"; `refreshInterval` row in the options table; troubleshooting entry for `poller.log`)
- Modify: `package.json` (`"version": "2.1.0"`)
- Modify: `docs/superpowers/specs/2026-11-09-shared-poller-design.md` (Status: implemented)

- [ ] **Step 1: Write the README section.** Cover: one poller per machine, socket path and `OPS_HUD_POLLER_SOCKET`, what the budget field means, idle/active ticks, that `refreshInterval` is the active tick, the in-process fallback, and where `poller.log` is. Keep the tone of the existing README.

- [ ] **Step 2: Bump the version and run the full gate**

Run: `bun run build && bun run check && bun test`
Expected: all PASS.

- [ ] **Step 3: Live verification, isolated from the panes already running on this machine**

Run, in three terminals, from the worktree:
```bash
export OPS_HUD_POLLER_SOCKET=/tmp/ops-hud-verify.sock
bun dist/index.js ~/Projects/gh-hud        # terminal 1
bun dist/index.js ~/Projects/gh-hud        # terminal 2
bun dist/index.js -r mquinnv/ops-hud mquinnv/spec-workflow-dashboard   # terminal 3
```
Then: `tail -f ~/.cache/ops-hud/poller.log`.
Expected: one `__poller` process (`pgrep -fl __poller`); the log shows each repo polled once per tick regardless of three panes; mostly `304` lines with `remaining` not decreasing on them; the status bar in every pane shows `GH <n>/5000 · resets HH:MM`; quitting terminals 1 and 2 leaves terminal 3 working; quitting terminal 3 and waiting 60s leaves no `__poller` process and no `/tmp/ops-hud-verify.sock`.

- [ ] **Step 4: Record the outcome in the spec's Status line and commit**

```bash
git add README.md package.json docs/superpowers/specs/2026-11-09-shared-poller-design.md
git commit -m "docs: describe the shared poller; 2.1.0"
```

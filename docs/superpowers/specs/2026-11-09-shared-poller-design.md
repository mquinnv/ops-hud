# ops-hud: one poller per machine

Date: 2026-11-09
Status: approved in conversation, pending builder check

## Summary

Move all CI polling out of the dashboard panes and into a single background
poller per machine. Panes connect to it over a Unix socket, say which
repositories they watch, and receive snapshots whenever something changes.
Ten panes watching the same repository cost one poll of that repository. The
poller talks to GitHub directly with conditional requests, polls only as fast
as the state of each repository warrants, and reads the rate-limit headers so
it slows down before GitHub refuses it.

## Motivation

Michael runs ops-hud as a pane in many claudemux sessions at once, often ten
or more, and several of them usually watch the same repository. Today each
pane is a complete, independent poller:

- Every 5 seconds a pane spawns `gh api` for the run list of each repository,
  then `gh api` again for the jobs of every active run. `--show-prs` adds a
  `gh pr list` per repository on the same tick.
- The provider's 5-second cache expires on exactly the tick that would reuse
  it, so it never saves a request.
- Nothing reads `x-ratelimit-remaining`, and nothing backs off on a 403. A
  pane that is being refused keeps asking every 5 seconds.

One pane with two active runs spends about 2,200 requests an hour. GitHub's
budget is 5,000 an hour per user, shared with every other pane and every
other `gh` invocation on the machine. The limit gets hit routinely, and when
it does every pane goes dark together. Measured on 2026-11-09, the current
panes had already used 510 of the hour's budget mid-morning with little CI
activity.

The CPU cost is the same shape: each `gh` invocation is a process start that
loads config and resolves auth, and ten panes do it hundreds of times a
minute between them.

Two facts, verified live against api.github.com on 2026-11-09, make the
design below work:

- A conditional request (`If-None-Match` with the previous `ETag`) that
  returns `304 Not Modified` does **not** increment `x-ratelimit-used`.
  Polling an unchanged repository is free.
- `x-ratelimit-remaining` and `x-ratelimit-reset` arrive on every response,
  so a poller can see the budget shrinking without a separate call.

## Goals

- GitHub request volume on a machine running N panes over R distinct
  repositories is bounded by R, not N.
- An idle repository costs no rate-limit budget to keep watching.
- The poller never drives the account to zero: it stretches its tick as the
  budget runs low and pauses entirely when GitHub says to, resuming at the
  advertised reset time.
- No `gh` process is spawned on the polling path. `gh` is still used once for
  the token, and for the write actions (cancel, rerun, logs, PR actions),
  which are rare and user-initiated.
- A pane never shows stale data because another pane exists: a new run
  appears in every pane watching that repository within one active tick.
- Panes keep working with zero configuration change. Flags, config files,
  and keybindings are unchanged. Starting a pane with no poller running just
  works; closing the last pane leaves nothing behind within a minute.
- The budget is visible: the status bar shows GitHub's remaining requests and
  the time the window resets, and says so plainly when polling is paused.
- Buildkite's 50-per-minute budget is likewise spent once per machine.

## Non-goals

- Changing what the grid shows or how. `dashboard.ts` is touched only to
  display the budget string and to stop the per-tick spinner (see "Pane
  changes").
- Sharing per-pane view state (dismissals, the resurrect position, the
  recent-history window). Those stay in the pane; two panes on one repo may
  legitimately show different cards.
- A GitHub App or any auth beyond the user's existing `gh` login.
- Windows support for the shared poller. Windows panes run the poller
  in-process (the fallback below) and are otherwise unchanged.
- GraphQL, webhooks, or GitHub's Actions "check runs" events. Polling with
  ETags is sufficient and far simpler.
- Moving the pull-request header or Docker status into the poller. They stay
  per pane; PRs just poll less often (see "Pane changes").

## Anti-goals

- A poller that lingers. If it is still running an hour after the last pane
  quit, the design has failed.
- A poller that silently serves stale data. If it is paused or failing, every
  connected pane must say so in its status bar.
- Two pollers of the same version both polling. Two panes starting at the
  same instant must end up on one poller.
- A pane that hangs on startup because the poller is slow or absent. The
  fallback path must engage within a few seconds.

## Approach

Three options were considered.

**A. Per-pane fixes only: direct fetch, ETags, adaptive tick, backoff.**
Removes the process spawns and makes idle polling free, but N panes on one
repo still make N requests per tick, and N panes each see the budget
independently and each decide they still have room. With 10+ panes this
shrinks the problem without bounding it. Rejected as the whole answer; every
piece of it is kept inside the poller.

**B. A shared on-disk cache with a lock, no long-lived process.** Each pane
checks `~/.cache/ops-hud/<repo>.json`; if it is older than the tick, the pane
takes a lock and refreshes it. Bounds requests by R, but every pane still
polls the disk, the "who refreshes" race needs file locking that is fragile
on macOS, and there is no way to push a change to a pane the moment it lands.
Rejected.

**C. One poller process per machine, panes as socket clients.** *(chosen)*
Bounds requests by R, holds one view of the budget, pushes snapshots to panes
on change, and keeps the ETag table in one place. The cost is process
lifecycle: starting it, finding it, retiring it, and surviving its absence.
That lifecycle is the bulk of this design.

## Architecture

```
 pane (ops-hud .)        pane (ops-hud ~/x)        pane (ops-hud .)
      │ watch{repos}          │ watch{repos}             │ watch{repos}
      ▼                       ▼                          ▼
 ┌────────────────────────────────────────────────────────────────┐
 │  poller  ~/.cache/ops-hud/poller-<version>.sock                │
 │  ├─ subscriptions: union of every pane's repos                 │
 │  ├─ per repo: ETag + last runs, per active run: ETag + jobs    │
 │  ├─ scheduler: fast tick while active, slow tick while idle    │
 │  ├─ budget: x-ratelimit-* from every response, pause on 403    │
 │  └─ buildkite: existing provider, one instance per token+org   │
 └────────────────────────────────────────────────────────────────┘
      ▲ snapshot{runs,jobs,diagnostics,budget}  (pushed on change)
```

### Processes and discovery

The poller is the same `ops-hud` binary, started with a hidden `__poller`
subcommand. Nothing else about the CLI changes.

Socket path: `$XDG_CACHE_HOME/ops-hud/poller-<version>.sock`, defaulting to
`~/.cache/ops-hud/`. The directory is created `0700`. The version in the name
is the package version, so a freshly installed ops-hud never talks to a
poller running old code: it starts its own, and the old poller exits on its
own when its last old-version pane closes.

Pane startup, in order:

1. Connect to the socket. On success, go to "Session".
2. On `ECONNREFUSED` or `ENOENT`: if a socket file exists and its mtime is
   more than 5 seconds old, unlink it (it is stale: a poller that was killed
   without cleaning up). Spawn `ops-hud __poller` detached, stdio ignored,
   `unref()`ed, so it outlives the pane.
3. Retry the connect every 100ms for up to 3 seconds. On success, go to
   "Session".
4. If still unreachable, log a warning to the event log and run the poller
   in-process (same class, no socket). The pane is fully functional, just not
   shared. This is also the path on platforms without Unix sockets.

Two panes starting together may both reach step 2. Both spawn a poller; the
pollers race to `listen()`; the loser gets `EADDRINUSE` and exits
immediately; both panes' retry loops reach the winner. No lock file is
needed. The 5-second mtime guard in step 2 keeps a pane from unlinking a
socket that a competing poller bound a moment ago.

The poller removes its socket file on `SIGTERM`, `SIGINT`, and normal exit.

### Poller lifetime

The poller exits when it has had zero connected panes for 60 seconds. It
also exits if its socket file disappears from disk (checked once a minute),
since that means something else has taken the path, and on an unrecoverable
auth failure after the panes have been told (see "Auth").

### Session protocol

Newline-delimited JSON over the socket, both directions. Every message has a
`type`. Panes never need to parse anything but `type` and the payload the
type implies; unknown types are ignored on both sides.

Pane → poller:

- `hello { version, pid }` — first message. A poller whose version differs
  closes the connection; the pane then starts its own (this only happens if
  someone edits the socket name by hand).
- `watch { repositories: string[], interval: number, buildkite?: { token,
  org?, pipelines? } }` — replaces the pane's subscription. `interval` is the
  pane's `refreshInterval` in ms; the poller uses the minimum across panes
  for a repository, floored at 5,000. `buildkite` carries whatever the pane
  resolved from env and config, exactly as `BuildkiteProvider` is constructed
  today, so per-project config keeps working.
- `refresh { repositories? }` — the `r` key. The poller polls the named
  repositories (default: the pane's subscription) at once, ignoring the tick
  but not the budget pause, at most once every 2 seconds per repository.
- `older { id, repositories, before, limit }` — the `U` key. The poller
  performs `fetchOlderRuns` and replies with `older-result { id, runs,
  diagnostics }`. Routed through the poller only so that it is counted
  against the shared budget and paused with everything else.

Poller → pane:

- `snapshot { repositories, runs, jobs, diagnostics, budget }` — sent in full
  on `watch` and whenever anything in it changed for that pane's
  subscription. `runs` and `jobs` are the neutral `Run` and `Job` types from
  `src/types.ts`, already mapped, exactly what `App.performRefresh` builds
  today. `jobs` is an object keyed by `Run.key`. `diagnostics` are
  `ProviderDiagnostic[]`. `budget` is described below.
- `budget { ... }` — sent alone when only the budget changed (every poll
  changes it), so panes can keep the status bar current without a snapshot.
- `older-result` — see above.

Snapshots are per pane: a pane receives only runs whose `repo.fullName` is
in its subscription, plus the Buildkite runs from the provider instance built
from its own `buildkite` config. The poller decides "changed" by comparing a
stable serialization of the pane's filtered snapshot with the last one it
sent that pane.

### Polling GitHub

One `GitHubPoller` owns the HTTP side. It is injectable with a `fetch` and a
clock, like `BuildkiteProvider`, so every rule below is unit-testable with no
network.

**Auth.** Token from `GH_TOKEN`, then `GITHUB_TOKEN`, then one `gh auth
token` at poller start. On a 401, the token is re-resolved once; if that also
fails, every pane gets an error diagnostic naming `gh auth status`, and the
poller exits. The token is sent only to `https://api.github.com`.

**Requests.** `fetch` with `Authorization: Bearer`, `Accept:
application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, and
`If-None-Match` whenever an ETag is held for that URL. 30-second timeout. At
most 4 GitHub requests in flight at once, machine-wide.

**Per repository.** The run list is `GET
/repos/{owner}/{repo}/actions/runs?per_page=20` (the existing limit). On
200, map with `mapGitHubRun`, store body and ETag. On 304, keep the stored
runs. The repo is *active* if any stored run `isActive()`.

**Jobs.** For every active run, `GET
/repos/{owner}/{repo}/actions/runs/{id}/jobs` with its own ETag, each active
tick. For a run that has just finished, jobs are fetched once more and then
never again for that `(run id, run_attempt)`; the results are kept while the
run is in the snapshot. A rerun changes `run_attempt`, which makes it a new
key. Jobs for finished runs are the only thing the poller caches past a
change, because they cannot change.

**Tick.** Each repository has its own next-poll time.

| State | Tick |
|---|---|
| Any run active | the subscribed `interval` (min across panes, floor 5s) |
| Idle | 15s |
| Budget low (remaining under 10% of limit, or under 300) | 4× the above |
| Paused (remaining 0, or a 403/429) | nothing until `x-ratelimit-reset`, or `retry-after`, or 60s if neither |

The idle tick is 15 seconds rather than longer because a 304 is free and a
new run should still appear quickly. The 4× stretch is applied to the whole
poller, not per repository, because the budget is per user.

**Budget.** After every response the poller records `x-ratelimit-limit`,
`-remaining`, `-reset`, and `-used` from the `core` resource. A 403 or 429
whose body or headers indicate a rate limit (the regex the current provider
uses) pauses polling as in the table; any other 403 is a per-repo error
diagnostic (no access), not a pause. The budget message to panes is:

```
budget { provider: "github", limit, remaining, resetAt, pausedUntil?, stretched: boolean }
```

**Change detection.** A repository's contribution to snapshots is recomputed
only when a 200 arrived for its run list or for any of its job lists.

### Buildkite in the poller

`BuildkiteProvider` moves into the poller unchanged. The poller holds one
instance per distinct `(token, org, pipelines)` tuple received in `watch`
messages and calls `fetchRuns` with the union of the subscribing panes'
repositories on the same scheduler, honoring the provider's existing
15-second minimum and 429 backoff. Its diagnostics and the embedded jobs it
already returns flow into the snapshots of the panes that supplied that
tuple. An instance with no subscribers is dropped.

Buildkite tokens travel over a `0700`-directory Unix socket between processes
of the same user. That is the same trust boundary as the config file they
came from.

### Pane changes

`App` loses `performRefresh`'s fetching half and keeps its tracking half.
Concretely:

- A `PollerClient` (socket or in-process) replaces `this.providers` for
  reads. `App` sends `watch` after `buildRepositoryList`, and handles
  `snapshot` by running exactly the code that today follows the fetches in
  `performRefresh`: watched/completed/dismissed bookkeeping,
  `finishedInWindow`, `applyIsFailing`, `oldestWorkflowTimestamp`, and
  `dashboard.updateWorkflows`.
- `r` sends `refresh`. `U` sends `older` and handles the reply as
  `resurrectOldestRun` does now.
- Cancel, rerun, and logs still call the pane's own provider objects, which
  shell out to `gh` as today. After cancel or rerun, the pane sends `refresh`
  for that repository instead of calling `performRefresh(true)`.
- `--show-prs` keeps its per-pane `gh pr list`, on its own 30-second timer
  instead of every tick. `--show-docker` is unchanged (it is local, costs no
  budget).
- The per-tick spinner in the status bar goes away; the pane no longer knows
  when a tick happens. It shows briefly on `r`. The status bar gains a
  budget field, for example `GH 4489/5000 · resets 14:32`, turning to
  `GH paused until 14:32` or `GH slow (budget low)` when the poller says so,
  and `poller: in-process` when the fallback engaged. The empty-state panel
  and the red `⚠` warning keep working from the diagnostics as now.
- The event log notes `connected to poller (pid N)` on connect, and
  `poller gone, reconnecting` with a reconnect loop (the startup procedure
  again, from step 1) if the socket drops. During reconnect the last
  snapshot stays on screen.

`GitHubProvider` keeps `cancel`, `rerun`, `logs`, `listPullRequests`,
`listRepositories`, and `fetchOlderRuns` (used by the poller's `older`
handler). Its `fetchRuns`, `fetchJobs`, and the timed cache are deleted
along with the `gh api` calls that implemented them.

### Observability

The poller appends one line per poll to `~/.cache/ops-hud/poller.log`:
timestamp, repo, status code (200/304/403), remaining budget, tick chosen.
The file is truncated when it passes 1 MB. `ops-hud __poller --status` is
out of scope; the log and the status bar are enough to see what it is doing.

## Testing

As in the Buildkite work: no live network and no blessed in tests.

- `GitHubPoller` with an injected `fetch` and clock: ETag round trip, 304
  keeps data, jobs fetched only for active runs and once after finish,
  active/idle/stretched/paused ticks from the headers, the 4-in-flight cap,
  token re-resolution on 401.
- The scheduler: union of subscriptions, per-repo next-poll times, minimum
  interval across panes, instance dropped when unsubscribed.
- The protocol over a real Unix socket in a temp directory: two clients on
  one repo cause one poll, each gets a filtered snapshot, a client gets a
  snapshot only when its view changed, poller exits 60s (clock injected)
  after the last disconnect, `EADDRINUSE` loser exits.
- Client startup: connect, stale socket unlink, spawn-and-retry (spawn
  injected), fallback to in-process after the timeout.
- `App` with an injected `PollerClient`: the existing `app.test.ts` cases
  for watched/completed/dismissed/resurrect behavior re-expressed as
  snapshots fed in, which should be a smaller change than it sounds since
  those tests already inject providers.

## Rollout

Ships as 2.1.0. No flags or config keys change meaning except that
`refreshInterval` is now the *active* tick; the idle tick is fixed at 15s.
The README gains a short "How polling works" section describing the shared
poller, the socket path, and the budget field.

## Left to the builder

- Exact module layout under `src/poller/` and the name of the client class.
- The stable-serialization used for change detection.
- Whether the in-process fallback and the socket client share an interface
  by class or by duck typing.
- Log line format.
- How the status bar makes room for the budget field.

## Decisions made on Michael's behalf

Flagged so they can be reversed cheaply:

- Idle tick 15s, budget-low threshold 10% or 300, 4× stretch, 60s poller
  linger, 3s startup wait.
- PR header polls every 30s instead of every tick.
- Buildkite moves into the poller rather than staying per pane.
- The per-tick spinner is dropped.
- Windows gets the in-process fallback only.

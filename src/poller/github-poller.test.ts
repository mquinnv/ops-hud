import { describe, expect, test } from "bun:test"
import jobsFixture from "../fixtures/github-jobs.json"
import runsFixture from "../fixtures/github-runs.json"
import type { GitHubRunPayload } from "../providers/github-map.js"
import {
  type FetchLike,
  GITHUB_API,
  GitHubPoller,
  MAX_IN_FLIGHT,
  resolveGitHubToken,
  TOKEN_RETRY_MS,
} from "./github-poller.js"

const REPO = "mquinnv/gh-hud"
const RUNS_URL = `${GITHUB_API}/repos/${REPO}/actions/runs?per_page=20`
const jobsUrl = (id: number) => `${GITHUB_API}/repos/${REPO}/actions/runs/${id}/jobs`

const baseRun = runsFixture.workflow_runs[0] as GitHubRunPayload

function runPayload(
  id: number,
  status = "in_progress",
  conclusion: string | null = null,
  attempt = 1,
): GitHubRunPayload {
  return { ...baseRun, id, status, conclusion, run_attempt: attempt }
}

const runsBody = (...runs: GitHubRunPayload[]) => ({
  total_count: runs.length,
  workflow_runs: runs,
})

interface Reply {
  status: number
  headers?: Record<string, string>
  body?: unknown
}

interface Call {
  url: string
  headers: Headers
}

/** Records every request and answers from `route`, which sees the URL and its call count. */
function fakeFetch(route: (url: string, nth: number) => Reply) {
  const calls: Call[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: new Headers(init?.headers) })
    const nth = calls.filter((c) => c.url === url).length
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 2))
    inFlight--
    const reply = route(url, nth)
    const body = reply.status === 304 ? null : JSON.stringify(reply.body ?? {})
    return new Response(body, { status: reply.status, headers: reply.headers })
  }
  return {
    fetch,
    calls,
    get maxInFlight() {
      return maxInFlight
    },
    callsTo: (url: string) => calls.filter((c) => c.url === url),
  }
}

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t }
  return c
}

const token =
  (value: string | undefined = "tok") =>
  async () =>
    value

describe("run list", () => {
  test("sends bearer, accept and api-version headers to api.github.com", async () => {
    const f = fakeFetch(() => ({ status: 200, body: runsBody() }))
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token("secret") })
    await p.poll(REPO)
    expect(f.calls).toHaveLength(1)
    const [call] = f.calls
    expect(call.url).toBe(RUNS_URL)
    expect(call.url.startsWith("https://api.github.com/")).toBe(true)
    expect(call.headers.get("authorization")).toBe("Bearer secret")
    expect(call.headers.get("accept")).toBe("application/vnd.github+json")
    expect(call.headers.get("x-github-api-version")).toBe("2022-11-28")
    expect(call.headers.get("if-none-match")).toBeNull()
  })

  test("a 200 maps the fixture and stores its ETag", async () => {
    const f = fakeFetch((_url, nth) =>
      nth === 1
        ? { status: 200, headers: { etag: '"abc"' }, body: runsFixture }
        : { status: 304, headers: { etag: '"abc"' } },
    )
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    const first = await p.poll(REPO)
    expect(first.changed).toBe(true)
    const runs = p.state(REPO)?.runs ?? []
    expect(runs).toHaveLength(1)
    expect(runs[0].key).toBe(`github:${REPO}:${baseRun.id}`)
    expect(runs[0].status).toBe("passed")
    await p.poll(REPO)
    expect(f.callsTo(RUNS_URL)[1].headers.get("if-none-match")).toBe('"abc"')
  })

  test("a 304 keeps the stored runs and reports changed: false", async () => {
    const f = fakeFetch((_url, nth) =>
      nth === 1
        ? { status: 200, headers: { etag: '"abc"' }, body: runsFixture }
        : { status: 304, headers: { etag: '"abc"' } },
    )
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    const before = p.state(REPO)?.runs
    const second = await p.poll(REPO)
    expect(second.changed).toBe(false)
    expect(p.state(REPO)?.runs).toEqual(before ?? [])
    expect(p.state(REPO)?.runs).toHaveLength(1)
  })

  test("a 200 with different content reports changed: true", async () => {
    const f = fakeFetch((url, nth) => {
      if (url !== RUNS_URL) return { status: 200, body: { jobs: [] } }
      return nth === 1
        ? { status: 200, headers: { etag: '"a"' }, body: runsFixture }
        : { status: 200, headers: { etag: '"b"' }, body: runsBody(runPayload(7)) }
    })
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    const second = await p.poll(REPO)
    expect(second.changed).toBe(true)
    expect(p.state(REPO)?.runs.map((r) => r.id)).toEqual(["7"])
    expect(p.isActive(REPO)).toBe(true)
  })
})

describe("jobs", () => {
  test("jobs are fetched for every active run, each with its own ETag", async () => {
    const f = fakeFetch((url, nth) => {
      if (url === RUNS_URL) return { status: 200, body: runsBody(runPayload(1), runPayload(2)) }
      const tag = url === jobsUrl(1) ? '"j1"' : '"j2"'
      return nth === 1
        ? { status: 200, headers: { etag: tag }, body: jobsFixture }
        : { status: 304, headers: { etag: tag } }
    })
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    expect(f.callsTo(jobsUrl(1))).toHaveLength(1)
    expect(f.callsTo(jobsUrl(2))).toHaveLength(1)
    const jobs = p.state(REPO)?.jobs
    expect(jobs?.get(`github:${REPO}:1`)?.[0].id).toBe(String(jobsFixture.jobs[0].id))
    expect(jobs?.get(`github:${REPO}:1`)?.[0].runKey).toBe(`github:${REPO}:1`)
    expect(jobs?.get(`github:${REPO}:2`)).toHaveLength(1)

    await p.poll(REPO)
    expect(f.callsTo(jobsUrl(1))[1].headers.get("if-none-match")).toBe('"j1"')
    expect(f.callsTo(jobsUrl(2))[1].headers.get("if-none-match")).toBe('"j2"')
    expect(p.state(REPO)?.jobs.get(`github:${REPO}:1`)).toHaveLength(1)
  })

  test("jobs are not fetched for a run that was already finished when first seen", async () => {
    const f = fakeFetch(() => ({ status: 200, body: runsFixture }))
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    await p.poll(REPO)
    expect(f.calls.every((c) => c.url === RUNS_URL)).toBe(true)
    expect(p.isActive(REPO)).toBe(false)
    expect(p.state(REPO)?.jobs.size).toBe(0)
  })

  test("a run that goes active→finished gets one more jobs fetch, then none", async () => {
    let status = "in_progress"
    const f = fakeFetch((url) => {
      if (url === RUNS_URL) {
        const run = status === "completed" ? runPayload(5, "completed", "success") : runPayload(5)
        return { status: 200, body: runsBody(run) }
      }
      return { status: 200, body: jobsFixture }
    })
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    await p.poll(REPO)
    expect(f.callsTo(jobsUrl(5))).toHaveLength(2)
    status = "completed"
    await p.poll(REPO)
    expect(f.callsTo(jobsUrl(5))).toHaveLength(3)
    await p.poll(REPO)
    await p.poll(REPO)
    expect(f.callsTo(jobsUrl(5))).toHaveLength(3)
    expect(p.state(REPO)?.jobs.get(`github:${REPO}:5`)).toHaveLength(1)
  })

  test("a rerun (new run_attempt) is a new jobs key and is fetched again", async () => {
    let run = runPayload(5)
    const f = fakeFetch((url) =>
      url === RUNS_URL
        ? { status: 200, body: runsBody(run) }
        : { status: 200, headers: { etag: '"j"' }, body: jobsFixture },
    )
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    run = runPayload(5, "completed", "failure")
    await p.poll(REPO)
    await p.poll(REPO)
    expect(f.callsTo(jobsUrl(5))).toHaveLength(2)
    run = runPayload(5, "queued", null, 2)
    await p.poll(REPO)
    expect(f.callsTo(jobsUrl(5))).toHaveLength(3)
    // A fresh key starts with no ETag.
    expect(f.callsTo(jobsUrl(5))[2].headers.get("if-none-match")).toBeNull()
  })
})

const rateHeaders = (remaining: number, reset = 2_000) => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(reset),
})

describe("budget and errors", () => {
  test("every response feeds the budget", async () => {
    let remaining = 4000
    const f = fakeFetch((_url, nth) => {
      remaining--
      return nth === 1
        ? { status: 200, headers: { etag: '"x"', ...rateHeaders(remaining) }, body: runsFixture }
        : { status: 304, headers: rateHeaders(remaining) }
    })
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    expect(p.budget.snapshot().remaining).toBe(3999)
    await p.poll(REPO)
    expect(p.budget.snapshot().remaining).toBe(3998)
    expect(p.budget.snapshot().limit).toBe(5000)
  })

  test("a 403 rate limit pauses and yields one 'GitHub: API rate limit exceeded' diagnostic", async () => {
    const c = clock()
    const f = fakeFetch(() => ({
      status: 403,
      headers: rateHeaders(0, c.t / 1000 + 600),
      body: { message: "API rate limit exceeded for user ID 1." },
    }))
    const p = new GitHubPoller({ fetch: f.fetch, now: c.now, resolveToken: token() })
    const result = await p.poll(REPO)
    expect(result.changed).toBe(false)
    expect(p.budget.paused).toBe(true)
    expect(p.state(REPO)?.diagnostics).toEqual([
      {
        provider: "github",
        level: "error",
        message: "GitHub: API rate limit exceeded",
        repository: REPO,
      },
    ])
  })

  test("while paused, poll() makes no request", async () => {
    const c = clock()
    const f = fakeFetch(() => ({
      status: 429,
      headers: { "retry-after": "120" },
      body: { message: "slow down" },
    }))
    const p = new GitHubPoller({ fetch: f.fetch, now: c.now, resolveToken: token() })
    await p.poll(REPO)
    expect(f.calls).toHaveLength(1)
    c.t += 60_000
    await p.poll(REPO)
    expect(f.calls).toHaveLength(1)
    expect(p.state(REPO)?.diagnostics[0].message).toBe("GitHub: API rate limit exceeded")
    c.t += 61_000
    await p.poll(REPO)
    expect(f.calls).toHaveLength(2)
  })

  test("a 403 without rate-limit wording is a per-repo error diagnostic and does not pause", async () => {
    const f = fakeFetch(() => ({
      status: 403,
      headers: rateHeaders(4000),
      body: { message: "Resource not accessible by integration" },
    }))
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    expect(p.budget.paused).toBe(false)
    const [d] = p.state(REPO)?.diagnostics ?? []
    expect(d.level).toBe("error")
    expect(d.repository).toBe(REPO)
    expect(d.message).toBe(
      `GitHub: could not list runs for ${REPO} — 403 Resource not accessible by integration`,
    )
  })

  test("a 404 is a per-repo error diagnostic naming the repo, with diagnostic.repository set", async () => {
    const f = fakeFetch(() => ({ status: 404, body: { message: "Not Found" } }))
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    expect(p.budget.paused).toBe(false)
    expect(p.state(REPO)?.diagnostics).toEqual([
      {
        provider: "github",
        level: "error",
        message: `GitHub: could not list runs for ${REPO} — 404 Not Found`,
        repository: REPO,
      },
    ])
  })

  test("no more than 4 requests are in flight at once", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 100 + i)
    const f = fakeFetch((url) =>
      url === RUNS_URL
        ? { status: 200, body: runsBody(...ids.map((id) => runPayload(id))) }
        : { status: 200, body: jobsFixture },
    )
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    expect(f.calls).toHaveLength(11)
    expect(MAX_IN_FLIGHT).toBe(4)
    expect(f.maxInFlight).toBe(MAX_IN_FLIGHT)
  })
})

describe("auth", () => {
  test("no token: authState is unauthenticated, no request goes out, diagnostic names gh auth login", async () => {
    const f = fakeFetch(() => ({ status: 200, body: runsFixture }))
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: async () => undefined })
    expect(p.authState).toBe("unauthenticated")
    await p.poll(REPO)
    expect(p.authState).toBe("unauthenticated")
    expect(f.calls).toHaveLength(0)
    expect(p.state(REPO)?.diagnostics).toEqual([
      {
        provider: "github",
        level: "error",
        message: "GitHub: not logged in — run gh auth login",
        repository: REPO,
      },
    ])
  })

  test("the token is re-resolved after TOKEN_RETRY_MS and polling resumes", async () => {
    const c = clock()
    let available: string | undefined
    let resolves = 0
    const f = fakeFetch(() => ({ status: 200, body: runsFixture }))
    const p = new GitHubPoller({
      fetch: f.fetch,
      now: c.now,
      resolveToken: async () => {
        resolves++
        return available
      },
    })
    await p.poll(REPO)
    expect(resolves).toBe(1)
    available = "late"
    c.t += TOKEN_RETRY_MS - 1
    await p.poll(REPO)
    expect(resolves).toBe(1)
    expect(f.calls).toHaveLength(0)
    c.t += 1
    await p.poll(REPO)
    expect(resolves).toBe(2)
    expect(p.authState).toBe("ok")
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].headers.get("authorization")).toBe("Bearer late")
    expect(p.state(REPO)?.diagnostics).toEqual([])
  })

  test("a 401 re-resolves once; if that fails the state is unauthenticated", async () => {
    const tokens = ["old", "new"]
    let resolves = 0
    const f = fakeFetch(() => ({ status: 401, body: { message: "Bad credentials" } }))
    const p = new GitHubPoller({
      fetch: f.fetch,
      resolveToken: async () => tokens[resolves++],
    })
    await p.poll(REPO)
    // old → 401 → re-resolves once to new → retried once → 401 again: give up.
    expect(f.calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer old", "Bearer new"])
    expect(resolves).toBe(2)
    expect(p.authState).toBe("unauthenticated")
    expect(p.state(REPO)?.diagnostics[0].message).toBe("GitHub: not logged in — run gh auth login")
    await p.poll(REPO)
    expect(f.calls).toHaveLength(2)
  })

  test("a 401 whose re-resolution returns the same token is unauthenticated", async () => {
    let resolves = 0
    const f = fakeFetch(() => ({ status: 401, body: { message: "Bad credentials" } }))
    const p = new GitHubPoller({
      fetch: f.fetch,
      resolveToken: async () => {
        resolves++
        return "same"
      },
    })
    await p.poll(REPO)
    expect(resolves).toBe(2)
    expect(f.calls).toHaveLength(1)
    expect(p.authState).toBe("unauthenticated")
  })

  test("resolveGitHubToken prefers GH_TOKEN, then GITHUB_TOKEN, then gh auth token", async () => {
    const calls: string[][] = []
    const gh = async (file: string, args: string[]) => {
      calls.push([file, ...args])
      return { stdout: "from-gh\n" }
    }
    expect(await resolveGitHubToken({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }, gh)).toBe("a")
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "b" }, gh)).toBe("b")
    expect(calls).toHaveLength(0)
    expect(await resolveGitHubToken({ GH_TOKEN: "" }, gh)).toBe("from-gh")
    expect(calls).toEqual([["gh", "auth", "token"]])
    expect(await resolveGitHubToken({}, async () => ({ stdout: "  \n" }))).toBeUndefined()
    expect(
      await resolveGitHubToken({}, async () => {
        throw new Error("gh: not found")
      }),
    ).toBeUndefined()
  })
})

describe("fetchOlder", () => {
  const OTHER = "acme/widgets"
  const BEFORE = "2026-08-01T00:00:00Z"
  const olderUrl = (repo: string) =>
    `${GITHUB_API}/repos/${repo}/actions/runs?per_page=2&created=${encodeURIComponent(`<${BEFORE}`)}`

  test("asks for created=<before with per_page=limit and returns the newest first", async () => {
    const at = (id: number, created: string, full: string) => ({
      ...runPayload(id, "completed", "success"),
      created_at: created,
      repository: { ...baseRun.repository, full_name: full },
    })
    const f = fakeFetch((url) =>
      url === olderUrl(REPO)
        ? {
            status: 200,
            body: runsBody(
              at(1, "2026-07-30T00:00:00Z", REPO),
              at(2, "2026-07-10T00:00:00Z", REPO),
            ),
          }
        : { status: 200, body: runsBody(at(3, "2026-07-20T00:00:00Z", OTHER)) },
    )
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    const result = await p.fetchOlder([REPO, OTHER], BEFORE, 2)
    expect(f.calls.map((c) => c.url).sort()).toEqual([olderUrl(OTHER), olderUrl(REPO)].sort())
    expect(result.runs.map((r) => r.id)).toEqual(["1", "3"])
    expect(result.diagnostics).toEqual([])
  })

  test("a rate limit yields the diagnostic instead of an empty result", async () => {
    const c = clock()
    const f = fakeFetch(() => ({
      status: 403,
      headers: rateHeaders(0, c.t / 1000 + 600),
      body: { message: "API rate limit exceeded" },
    }))
    const p = new GitHubPoller({ fetch: f.fetch, now: c.now, resolveToken: token() })
    const result = await p.fetchOlder([REPO], BEFORE, 2)
    expect(result.runs).toEqual([])
    expect(result.diagnostics.map((d) => d.message)).toEqual(["GitHub: API rate limit exceeded"])
    expect(result.diagnostics[0].repository).toBe(REPO)
    // Paused now: a second call sends nothing and still says why.
    const again = await p.fetchOlder([REPO], BEFORE, 2)
    expect(f.calls).toHaveLength(1)
    expect(again.diagnostics.map((d) => d.message)).toEqual(["GitHub: API rate limit exceeded"])
  })
})

describe("forget", () => {
  test("drops the repo's state", async () => {
    const f = fakeFetch(() => ({ status: 200, body: runsFixture }))
    const p = new GitHubPoller({ fetch: f.fetch, resolveToken: token() })
    await p.poll(REPO)
    p.forget(REPO)
    expect(p.state(REPO)).toBeUndefined()
    expect(p.isActive(REPO)).toBe(false)
  })
})

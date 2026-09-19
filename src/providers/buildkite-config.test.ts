import { describe, expect, test } from "bun:test"
import type { Run } from "../types.js"
import { BuildkiteProvider, nextLink, resolveBuildkiteToken } from "./buildkite.js"
import type { Scope } from "./types.js"

const emptyScope: Scope = { repositories: [] }

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.headers,
  })
}

function sampleRun(overrides: Partial<Run> = {}): Run {
  return {
    provider: "buildkite",
    key: "buildkite:inetalliance/usm:abc",
    id: "abc",
    number: 42,
    title: "a title",
    pipeline: "site-content-usm",
    pipelineSlug: "site-content-usm",
    branch: "main",
    sha: "deadbeef",
    status: "running",
    isFailing: false,
    repo: { owner: "inetalliance", name: "usm", fullName: "inetalliance/usm" },
    webUrl: "https://buildkite.com/ameriglide/site-content-usm/builds/42",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

const usmPipeline = {
  id: "p1",
  url: "x",
  web_url: "x",
  name: "site-content-usm",
  slug: "site-content-usm",
  repository: "git@github.com:inetalliance/usm.git",
}

const distributorsPipeline = {
  id: "p2",
  url: "x",
  web_url: "x",
  name: "site-content-usm-distributors",
  slug: "site-content-usm-distributors",
  repository: "git@github.com:inetalliance/distributors.git",
}

function buildPayload(id: string, number: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    number,
    state: "passed",
    commit: "deadbeef",
    branch: "main",
    web_url: "https://buildkite.com/x",
    created_at: "2026-01-01T00:00:00Z",
    pipeline: {
      slug: "site-content-usm",
      name: "site-content-usm",
      repository: "git@github.com:inetalliance/usm.git",
    },
    jobs: [],
    ...overrides,
  }
}

describe("resolveBuildkiteToken", () => {
  test("prefers the environment variable over config", () => {
    expect(resolveBuildkiteToken({ BUILDKITE_API_TOKEN: "env" }, { token: "cfg" })).toBe("env")
  })

  test("falls back to config", () => {
    expect(resolveBuildkiteToken({}, { token: "cfg" })).toBe("cfg")
  })

  test("returns undefined when neither is set", () => {
    expect(resolveBuildkiteToken({}, {})).toBeUndefined()
    expect(resolveBuildkiteToken({}, undefined)).toBeUndefined()
  })

  // An empty string in config is a half-finished edit, not a token.
  test("treats blank values as absent", () => {
    expect(resolveBuildkiteToken({ BUILDKITE_API_TOKEN: "  " }, { token: "" })).toBeUndefined()
  })
})

describe("nextLink", () => {
  test("returns undefined when there is no header", () => {
    expect(nextLink(null)).toBeUndefined()
  })

  test("extracts the rel=next URL among other rels", () => {
    const header =
      '<https://api.buildkite.com/v2/x?page=1>; rel="prev", <https://api.buildkite.com/v2/x?page=2>; rel="next"'
    expect(nextLink(header)).toBe("https://api.buildkite.com/v2/x?page=2")
  })

  test("returns undefined when there is no next rel", () => {
    const header = '<https://api.buildkite.com/v2/x?page=1>; rel="prev"'
    expect(nextLink(header)).toBeUndefined()
  })
})

describe("BuildkiteProvider without a token", () => {
  // The tool must stay installable and useful for people with no Buildkite
  // account at all, so this path is a skip, not an error.
  test("skips quietly and contributes nothing", async () => {
    const provider = new BuildkiteProvider({ token: undefined })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].level).toBe("info")
    expect(result.diagnostics[0].message).toContain("no token")
  })

  test("does not implement fetchOlderRuns — Buildkite opts out of resurrect", () => {
    const provider = new BuildkiteProvider({ token: undefined })
    expect(provider.fetchOlderRuns).toBeUndefined()
  })
})

describe("BuildkiteProvider with a failing token", () => {
  // The opposite rule: a token that is present and broken must be loud, or a
  // misconfiguration is indistinguishable from an idle CI system.
  test("reports a rejected token as an error", async () => {
    const provider = new BuildkiteProvider({
      token: "bad",
      org: "acme",
      fetch: async () => new Response("", { status: 401 }),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("rejected")
  })

  // Found live: a token with read_builds and read_pipelines, but no
  // read_organizations, got a 403 from org auto-detection — and the message
  // told the user to add the two scopes they already had.
  test("a rejected org lookup names read_organizations, and the way around it", async () => {
    const provider = new BuildkiteProvider({
      token: "no-org-scope",
      fetch: async (url: string) =>
        url.endsWith("/organizations")
          ? new Response("", { status: 403 })
          : new Response("[]", { status: 200 }),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("read_organizations")
    expect(result.diagnostics[0].message).toContain("buildkite.org")
    expect(result.diagnostics[0].message).not.toContain("read_builds")
  })

  test("a rejected builds read still names the read scopes", async () => {
    const provider = new BuildkiteProvider({
      token: "bad",
      org: "acme",
      fetch: async () => new Response("", { status: 403 }),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].message).toContain("read_builds, read_pipelines")
  })

  test("reports an ambiguous organization", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async () => jsonResponse([{ slug: "one" }, { slug: "two" }]),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("one")
    expect(result.diagnostics[0].message).toContain("two")
  })

  test("reports token reaching no organizations", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async () => jsonResponse([]),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("no organizations")
  })

  test("auto-detects a sole organization and uses it in subsequent requests", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.endsWith("/organizations")) {
          return jsonResponse([{ slug: "ameriglide" }])
        }
        return jsonResponse([])
      },
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics.some((d) => d.level === "error")).toBe(false)
    expect(requestedUrls.some((u) => u.includes("ameriglide"))).toBe(true)
  })
})

describe("BuildkiteProvider org resolution caching", () => {
  test("caches a resolved org — a second fetchRuns makes no /organizations call", async () => {
    let orgCalls = 0
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async (url: string) => {
        if (url.endsWith("/organizations")) {
          orgCalls++
          return jsonResponse([{ slug: "ameriglide" }])
        }
        return jsonResponse([])
      },
    })

    await provider.fetchRuns(emptyScope)
    await provider.fetchRuns(emptyScope)
    expect(orgCalls).toBe(1)
  })

  test("does not cache a failed org lookup — the next refresh retries", async () => {
    let orgCalls = 0
    let now = 0
    const provider = new BuildkiteProvider({
      token: "good",
      now: () => now,
      fetch: async (url: string) => {
        if (url.endsWith("/organizations")) {
          orgCalls++
          return jsonResponse([])
        }
        return jsonResponse([])
      },
    })

    await provider.fetchRuns(emptyScope)
    now += 16_000 // past the minimum fetch interval
    await provider.fetchRuns(emptyScope)
    expect(orgCalls).toBe(2)
  })
})

describe("BuildkiteProvider pipeline index caching", () => {
  test("does not refetch the index within the 5-minute TTL", async () => {
    let indexCalls = 0
    let now = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => now,
      fetch: async (url: string) => {
        if (url.includes("/pipelines?")) {
          indexCalls++
          return jsonResponse([usmPipeline])
        }
        return jsonResponse([])
      },
    })

    await provider.fetchRuns({ repositories: ["inetalliance/usm"] })
    now += 60_000 // one minute later — still within the TTL
    await provider.fetchRuns({ repositories: ["inetalliance/usm"] })
    expect(indexCalls).toBe(1)
  })

  test("refetches the index once the TTL has expired", async () => {
    let indexCalls = 0
    let now = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => now,
      fetch: async (url: string) => {
        if (url.includes("/pipelines?")) {
          indexCalls++
          return jsonResponse([usmPipeline])
        }
        return jsonResponse([])
      },
    })

    await provider.fetchRuns({ repositories: ["inetalliance/usm"] })
    now += 6 * 60_000 // six minutes later — past the TTL
    await provider.fetchRuns({ repositories: ["inetalliance/usm"] })
    expect(indexCalls).toBe(2)
  })

  test("does not cache a failed index fetch", async () => {
    let indexCalls = 0
    let now = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => now,
      fetch: async (url: string) => {
        if (url.includes("/pipelines?")) {
          indexCalls++
          return new Response("", { status: 500 })
        }
        return jsonResponse([])
      },
    })

    await provider.fetchRuns({ repositories: ["inetalliance/usm"] })
    now += 16_000 // past the minimum fetch interval
    await provider.fetchRuns({ repositories: ["inetalliance/usm"] })
    expect(indexCalls).toBe(2)
  })

  test("follows Link: rel=next across two pages of the pipeline index", async () => {
    let indexCalls = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("&page=2")) {
          indexCalls++
          return jsonResponse([distributorsPipeline])
        }
        if (url.includes("/pipelines?")) {
          indexCalls++
          return jsonResponse([usmPipeline], {
            headers: {
              link: '<https://api.buildkite.com/v2/organizations/acme/pipelines?per_page=100&page=2>; rel="next"',
            },
          })
        }
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/usm", "inetalliance/distributors"],
    })

    expect(indexCalls).toBe(2)
    // Both repos resolved thanks to the two pages having been merged; neither
    // produces the "no pipeline" diagnostic.
    expect(result.diagnostics.some((d) => d.message.includes("no pipeline"))).toBe(false)
  })
})

describe("BuildkiteProvider.fetchRuns endpoint selection", () => {
  test("scoped repositories fetch per-pipeline builds, not the org-wide endpoint", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines?")) return jsonResponse([usmPipeline])
        if (url.includes("/pipelines/site-content-usm/builds")) {
          return jsonResponse([buildPayload("b1", 1)])
        }
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/usm"],
    })

    expect(result.runs).toHaveLength(1)
    expect(
      requestedUrls.some((u) =>
        u.includes("/organizations/acme/pipelines/site-content-usm/builds"),
      ),
    ).toBe(true)
    expect(requestedUrls.some((u) => u.endsWith("/organizations/acme/builds?per_page=20"))).toBe(
      false,
    )
  })

  test("unscoped fetch hits the org-wide builds endpoint, and never the pipeline index", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/organizations/acme/builds")) return jsonResponse([buildPayload("b1", 1)])
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns(emptyScope)

    expect(result.runs).toHaveLength(1)
    expect(requestedUrls.some((u) => u.includes("/organizations/acme/builds?per_page=100"))).toBe(
      true,
    )
    expect(requestedUrls.some((u) => u.includes("/pipelines"))).toBe(false)
  })

  test("a scoped repo with no matching pipeline produces an info diagnostic naming it", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/pipelines?")) return jsonResponse([usmPipeline])
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/no-such-repo"],
    })

    expect(result.runs).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].level).toBe("info")
    expect(result.diagnostics[0].message).toContain("inetalliance/no-such-repo")
  })

  test("never sends exclude_jobs on any request", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines?")) return jsonResponse([usmPipeline])
        return jsonResponse([buildPayload("b1", 1)])
      },
    })

    await provider.fetchRuns({ repositories: ["inetalliance/usm"] })
    await provider.fetchRuns(emptyScope)

    expect(requestedUrls.some((u) => u.includes("exclude_jobs"))).toBe(false)
  })

  test("CRITICAL: ignores a Link header on the org-wide builds endpoint — one page only", async () => {
    let buildsCalls = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/organizations/acme/builds")) {
          buildsCalls++
          return jsonResponse([buildPayload("b1", 1)], {
            headers: {
              link: '<https://api.buildkite.com/v2/organizations/acme/builds?per_page=20&page=2>; rel="next"',
            },
          })
        }
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toHaveLength(1)
    expect(buildsCalls).toBe(1)
  })

  test("CRITICAL: ignores a Link header on a per-pipeline builds endpoint — one page only", async () => {
    let buildsCalls = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/pipelines?")) return jsonResponse([usmPipeline])
        if (url.includes("/pipelines/site-content-usm/builds")) {
          buildsCalls++
          return jsonResponse([buildPayload("b1", 1)], {
            headers: {
              link: '<https://api.buildkite.com/v2/organizations/acme/pipelines/site-content-usm/builds?per_page=20&page=2>; rel="next"',
            },
          })
        }
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/usm"],
    })
    expect(result.runs).toHaveLength(1)
    expect(buildsCalls).toBe(1)
  })
})

describe("BuildkiteProvider.fetchRuns pipeline selection modes", () => {
  test("an explicit pipeline list is fetched directly when the scope is unscoped", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      pipelines: ["explicit-slug"],
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines/explicit-slug/builds"))
          return jsonResponse([buildPayload("b1", 1)])
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns(emptyScope)

    expect(result.runs).toHaveLength(1)
    expect(requestedUrls.some((u) => u.includes("/pipelines/explicit-slug/builds"))).toBe(true)
    expect(requestedUrls.some((u) => u.includes("/organizations/acme/builds?per_page"))).toBe(false)
    expect(requestedUrls.some((u) => u.includes("/pipelines?per_page"))).toBe(false)
  })

  test("an explicit pipeline list wins over scope.repositories — the repo is never looked up in the index", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      pipelines: ["explicit-slug"],
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines/explicit-slug/builds"))
          return jsonResponse([buildPayload("b1", 1)])
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/usm"],
    })

    expect(result.runs).toHaveLength(1)
    expect(requestedUrls.some((u) => u.includes("/pipelines/explicit-slug/builds"))).toBe(true)
    // The index is never fetched at all — the explicit list bypasses it entirely.
    expect(requestedUrls.some((u) => u.includes("/pipelines?per_page"))).toBe(false)
    expect(result.diagnostics).toEqual([])
  })

  test("an empty explicit list falls back to deriving slugs from scope.repositories", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      pipelines: [],
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines?")) return jsonResponse([usmPipeline])
        if (url.includes("/pipelines/site-content-usm/builds")) {
          return jsonResponse([buildPayload("b1", 1)])
        }
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/usm"],
    })

    expect(result.runs).toHaveLength(1)
    expect(requestedUrls.some((u) => u.includes("/pipelines?"))).toBe(true)
  })
})

describe("BuildkiteProvider.fetchRuns error handling", () => {
  test("a non-auth HTTP error becomes an error diagnostic naming the status and path", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async () => new Response("", { status: 500 }),
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toBe(
      "Buildkite: HTTP 500 from /organizations/acme/builds?per_page=100",
    )
  })

  test("a network error (fetch rejects) becomes an error diagnostic and fetchRuns resolves", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async () => {
        throw new Error("network down")
      },
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("network down")
  })

  test("malformed JSON becomes an error diagnostic and fetchRuns resolves", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async () => new Response("not json", { status: 200 }),
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics[0].level).toBe("error")
  })

  test("one failing pipeline produces an error diagnostic naming it, without hiding the rest", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      pipelines: ["missing-slug", "site-content-usm"],
      fetch: async (url: string) => {
        if (url.includes("/pipelines/missing-slug/builds")) return new Response("", { status: 404 })
        if (url.includes("/pipelines/site-content-usm/builds"))
          return jsonResponse([buildPayload("b1", 1)])
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toHaveLength(1)
    const errorDiag = result.diagnostics.find((d) => d.level === "error")
    expect(errorDiag?.message).toContain("missing-slug")
    expect(errorDiag?.message).toContain("404")
  })

  test("a malformed build payload (no jobs field) becomes a diagnostic, not a rejection", async () => {
    // A build payload missing `jobs` entirely, as a real API response never should.
    const { jobs: _jobs, ...malformed } = buildPayload("b1", 1)

    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async () => jsonResponse([malformed, buildPayload("b2", 2)]),
    })

    const result = await provider.fetchRuns(emptyScope)
    // The well-formed build still comes through; the malformed one is a diagnostic.
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].id).toBe("b2")
    expect(result.diagnostics.some((d) => d.level === "error")).toBe(true)
  })
})

describe("BuildkiteProvider host restriction", () => {
  test("logs() refuses to send the token to a non-Buildkite host", async () => {
    let evilHostCalled = false
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("evil.example")) {
          evilHostCalled = true
          return jsonResponse({ content: "should never be requested" })
        }
        return jsonResponse(
          buildPayload("b1", 42, {
            jobs: [{ id: "j", state: "failed", log_url: "https://evil.example/log" }],
          }),
        )
      },
    })

    await expect(provider.logs(sampleRun())).rejects.toThrow(/unexpected host/)
    expect(evilHostCalled).toBe(false)
  })

  test("getAll refuses to follow a Link header to a non-Buildkite host", async () => {
    let evilHostCalled = false
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("evil.example")) {
          evilHostCalled = true
          return jsonResponse([])
        }
        if (url.includes("/pipelines?")) {
          return jsonResponse([usmPipeline], {
            headers: { link: '<https://evil.example/next>; rel="next"' },
          })
        }
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/usm"],
    })
    // The bad Link is caught and turned into a diagnostic, not sent to.
    expect(result.diagnostics.some((d) => d.message.includes("unexpected host"))).toBe(true)
    expect(evilHostCalled).toBe(false)
  })
})

describe("BuildkiteProvider.fetchJobs", () => {
  test("always returns empty — jobs arrive embedded with the build", async () => {
    const provider = new BuildkiteProvider({ token: "good", org: "acme" })
    const jobs = await provider.fetchJobs(sampleRun())
    expect(jobs).toEqual([])
  })
})

describe("BuildkiteProvider actions", () => {
  test("cancel issues a PUT to the cancel endpoint", async () => {
    let method: string | undefined
    let url: string | undefined
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (u: string, init?: RequestInit) => {
        url = u
        method = init?.method
        return jsonResponse({})
      },
    })

    await provider.cancel(sampleRun())
    expect(method).toBe("PUT")
    expect(url).toBe(
      "https://api.buildkite.com/v2/organizations/acme/pipelines/site-content-usm/builds/42/cancel",
    )
  })

  test("rerun issues a PUT to the rebuild endpoint", async () => {
    let method: string | undefined
    let url: string | undefined
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (u: string, init?: RequestInit) => {
        url = u
        method = init?.method
        return jsonResponse({})
      },
    })

    await provider.rerun(sampleRun())
    expect(method).toBe("PUT")
    expect(url).toBe(
      "https://api.buildkite.com/v2/organizations/acme/pipelines/site-content-usm/builds/42/rebuild",
    )
  })

  test("cancel rejects a run with no pipeline slug", async () => {
    const provider = new BuildkiteProvider({ token: "good", org: "acme" })
    await expect(provider.cancel(sampleRun({ pipelineSlug: undefined }))).rejects.toThrow()
  })

  test("a 403 on cancel names write_builds, not the read scopes", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async () => new Response("", { status: 403 }),
    })
    await expect(provider.cancel(sampleRun())).rejects.toThrow(/write_builds/)
  })
})

describe("BuildkiteProvider.logs", () => {
  function jobPayload(overrides: Record<string, unknown>) {
    return {
      id: "j",
      state: "passed",
      ...overrides,
    }
  }

  test("prefers the first failed or timed-out job with a log_url", async () => {
    let requestedLogUrl: string | undefined
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/log/")) {
          requestedLogUrl = url
          return jsonResponse({ content: "failure output" })
        }
        return jsonResponse(
          buildPayload("b1", 42, {
            state: "failed",
            jobs: [
              jobPayload({
                id: "upload",
                state: "passed",
                log_url: "https://api.buildkite.com/v2/log/upload",
              }),
              jobPayload({
                id: "failing",
                state: "failed",
                log_url: "https://api.buildkite.com/v2/log/failing",
              }),
              jobPayload({
                id: "later",
                state: "passed",
                log_url: "https://api.buildkite.com/v2/log/later",
              }),
            ],
          }),
        )
      },
    })

    const content = await provider.logs(sampleRun())
    expect(content).toBe("failure output")
    expect(requestedLogUrl).toBe("https://api.buildkite.com/v2/log/failing")
  })

  // M1: log text needs read_build_logs; blaming read_builds sends the user
  // to fix a scope they already have.
  test("a 403 on a job's log_url names read_build_logs", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/log/")) return new Response("", { status: 403 })
        return jsonResponse(
          buildPayload("b1", 42, {
            jobs: [
              jobPayload({
                id: "a",
                state: "failed",
                log_url: "https://api.buildkite.com/v2/log/a",
              }),
            ],
          }),
        )
      },
    })

    const error = await provider.logs(sampleRun()).catch((e: Error) => e)
    expect(String(error)).toContain("read_build_logs")
    expect(String(error)).not.toContain("read_pipelines")
  })

  test("falls back to the last job with a log_url when nothing failed", async () => {
    let requestedLogUrl: string | undefined
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/log/")) {
          requestedLogUrl = url
          return jsonResponse({ content: "last job output" })
        }
        return jsonResponse(
          buildPayload("b1", 42, {
            jobs: [
              jobPayload({
                id: "upload",
                state: "passed",
                log_url: "https://api.buildkite.com/v2/log/upload",
              }),
              jobPayload({
                id: "build",
                state: "passed",
                log_url: "https://api.buildkite.com/v2/log/build",
              }),
            ],
          }),
        )
      },
    })

    const content = await provider.logs(sampleRun())
    expect(content).toBe("last job output")
    expect(requestedLogUrl).toBe("https://api.buildkite.com/v2/log/build")
  })
})

describe("BuildkiteProvider job list (Ruling 34)", () => {
  test("waiter jobs are dropped from the jobs map; broken and soft-failed jobs are skipped", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async () =>
        jsonResponse([
          buildPayload("b1", 1, {
            state: "running",
            jobs: [
              { id: "build", type: "script", name: "build", state: "passed" },
              { id: "wait", type: "waiter", state: "passed" },
              { id: "deploy", type: "script", name: "deploy", state: "broken" },
              { id: "lint", type: "script", name: "lint", state: "failed", soft_failed: true },
            ],
          }),
        ]),
    })

    const result = await provider.fetchRuns(emptyScope)
    const jobs = result.jobs?.get(result.runs[0].key) ?? []

    expect(jobs.map((j) => j.id)).toEqual(["build", "deploy", "lint"])
    expect(jobs.find((j) => j.id === "deploy")?.status).toBe("skipped")
    expect(jobs.find((j) => j.id === "lint")?.status).toBe("skipped")
  })
})

// Ruling 35: the REST limit is 50 requests/minute per user, shared with every
// other client on the token.
describe("BuildkiteProvider request budget", () => {
  function pipelineBuild(id: string, slug: string) {
    return buildPayload(id, 1, {
      pipeline: { slug, name: slug, repository: `git@github.com:acme/${slug}.git` },
    })
  }

  test("3 slugs make exactly one org-wide request, filtered to those slugs", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      pipelines: ["one", "two", "three"],
      fetch: async (url: string) => {
        requestedUrls.push(url)
        return jsonResponse([
          pipelineBuild("b1", "one"),
          pipelineBuild("b2", "three"),
          pipelineBuild("b3", "someone-elses"),
        ])
      },
    })

    const result = await provider.fetchRuns(emptyScope)

    expect(requestedUrls).toEqual([
      "https://api.buildkite.com/v2/organizations/acme/builds?per_page=100",
    ])
    expect(result.runs.map((r) => r.id)).toEqual(["b1", "b2"])
  })

  test("2 slugs make two per-pipeline requests", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      pipelines: ["one", "two"],
      fetch: async (url: string) => {
        requestedUrls.push(url)
        return jsonResponse([])
      },
    })

    await provider.fetchRuns(emptyScope)

    expect(requestedUrls).toEqual([
      "https://api.buildkite.com/v2/organizations/acme/pipelines/one/builds?per_page=20",
      "https://api.buildkite.com/v2/organizations/acme/pipelines/two/builds?per_page=20",
    ])
  })

  test("calls 5s apart make one network fetch; calls 16s apart make two", async () => {
    let requests = 0
    let now = 1_000_000
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => now,
      fetch: async () => {
        requests++
        return jsonResponse([buildPayload("b1", 1)])
      },
    })

    const first = await provider.fetchRuns(emptyScope)
    now += 5_000
    const second = await provider.fetchRuns(emptyScope)
    expect(requests).toBe(1)
    expect(second).toEqual(first)

    now += 11_000 // 16s after the first fetch began
    await provider.fetchRuns(emptyScope)
    expect(requests).toBe(2)
  })

  test("a 429 with RateLimit-User-Reset backs off for that long, keeping the last good runs", async () => {
    let requests = 0
    let now = 1_000_000
    let throttle = false
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => now,
      fetch: async () => {
        requests++
        if (throttle) {
          return jsonResponse(
            { message: "slow down" },
            { status: 429, headers: { "RateLimit-User-Reset": "42", "RateLimit-Reset": "7" } },
          )
        }
        return jsonResponse([buildPayload("good-build", 1)])
      },
    })

    await provider.fetchRuns(emptyScope)
    expect(requests).toBe(1)

    throttle = true
    now += 20_000
    const limited = await provider.fetchRuns(emptyScope)
    expect(requests).toBe(2)
    expect(limited.runs.map((r) => r.id)).toEqual(["good-build"])
    expect(limited.jobs?.size).toBe(1)
    expect(limited.diagnostics).toEqual([
      {
        provider: "buildkite",
        level: "error",
        message: "Buildkite: rate limited — retrying in 42s",
      },
    ])
    expect(limited.diagnostics[0].message).not.toContain("rejected")

    // 20s into the 42s backoff: no request, still the last good runs.
    now += 20_000
    const during = await provider.fetchRuns(emptyScope)
    expect(requests).toBe(2)
    expect(during.runs.map((r) => r.id)).toEqual(["good-build"])
    expect(during.diagnostics).toHaveLength(1)
    expect(during.diagnostics[0].message).toBe("Buildkite: rate limited — retrying in 22s")

    // 41.5s in: still backing off (22s rounded up from the remaining 0.5s → 1s).
    now += 21_500
    const almost = await provider.fetchRuns(emptyScope)
    expect(requests).toBe(2)
    expect(almost.diagnostics[0].message).toBe("Buildkite: rate limited — retrying in 1s")

    // After the reset: requests resume.
    throttle = false
    now += 1_000
    const resumed = await provider.fetchRuns(emptyScope)
    expect(requests).toBe(3)
    expect(resumed.diagnostics).toEqual([])
  })

  test("a 429 with only RateLimit-Reset uses it", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => 0,
      fetch: async () =>
        jsonResponse({ reset: 99 }, { status: 429, headers: { "RateLimit-Reset": "30" } }),
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].message).toBe("Buildkite: rate limited — retrying in 30s")
  })

  test("a 429 with no reset header falls back to the body's reset field", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => 0,
      fetch: async () => jsonResponse({ message: "limited", reset: 17 }, { status: 429 }),
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toBe("Buildkite: rate limited — retrying in 17s")
  })

  test("a 429 that names no reset time backs off for 60s", async () => {
    let requests = 0
    let now = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      now: () => now,
      fetch: async () => {
        requests++
        return new Response("", { status: 429 })
      },
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics[0].message).toBe("Buildkite: rate limited — retrying in 60s")

    now += 59_000
    await provider.fetchRuns(emptyScope)
    expect(requests).toBe(1)

    now += 2_000
    await provider.fetchRuns(emptyScope)
    expect(requests).toBe(2)
  })

  test("a 429 on the first of two pipelines stops the second request", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      pipelines: ["one", "two"],
      now: () => 0,
      fetch: async (url: string) => {
        requestedUrls.push(url)
        return new Response("", { status: 429, headers: { "RateLimit-User-Reset": "5" } })
      },
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(requestedUrls).toHaveLength(1)
    expect(result.diagnostics).toHaveLength(1)
  })
})

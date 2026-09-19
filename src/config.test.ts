import { describe, expect, test } from "bun:test"
import { execa } from "execa"
import { mkdtemp, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { isAbsolute, join } from "path"
import { ConfigManager, parseGitHubRemote, resolveRepoAtPath, resolveScope } from "./config.js"
import type { GitHubProvider } from "./providers/github.js"
import type { Repository } from "./types.js"

// `gh repo view` would ask the GitHub API about the remote; the tests exercise
// the git-remote fallback instead and never run the real `gh`.
const noGh = async (): Promise<string> => {
  throw new Error("gh is not available in tests")
}

/** A fresh, empty home directory, so no test ever reads the developer's real config. */
const freshHome = () => mkdtemp(join(tmpdir(), "ops-hud-home-"))

// A GitHubProvider whose org listing returns a repo we should never see once
// an explicit scope is in play — if it leaks into the result, orgs weren't cleared.
function githubReturningOrgRepo(fullName: string): GitHubProvider {
  return {
    listRepositories: async (): Promise<Repository[]> => [{ fullName } as Repository],
  } as unknown as GitHubProvider
}

describe("parseGitHubRemote", () => {
  test("parses an SSH remote", () => {
    expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets")
  })

  test("parses an HTTPS remote", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets.git")).toBe("acme/widgets")
  })

  test("parses a remote with no .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets")).toBe("acme/widgets")
  })

  test("keeps dots in the repository name", () => {
    expect(parseGitHubRemote("git@github.com:mrdoob/three.js.git")).toBe("mrdoob/three.js")
  })

  test("returns null for a non-GitHub remote", () => {
    expect(parseGitHubRemote("git@gitlab.com:acme/widgets.git")).toBeNull()
  })
})

describe("explicit repository scope", () => {
  test("suppresses organizations configured in the config file", async () => {
    const config = new ConfigManager()
    config.updateFromArgs({ organizations: ["ameriglide"] })

    config.setScopedRepositories(["acme/widgets"])
    const repos = await config.buildRepositoryList(githubReturningOrgRepo("ameriglide/other"))

    expect(repos).toEqual(["acme/widgets"])
  })

  test("leaves organizations alone when nothing is explicitly scoped", async () => {
    const config = new ConfigManager()
    config.updateFromArgs({ organizations: ["ameriglide"] })

    const repos = await config.buildRepositoryList(githubReturningOrgRepo("ameriglide/other"))

    expect(repos).toEqual(["ameriglide/other"])
  })
})

describe("resolveRepoAtPath", () => {
  test("resolves a checkout's GitHub remote to owner/repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-test-"))
    await execa("git", ["init", "-q"], { cwd: dir })
    await execa("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir })

    expect(await resolveRepoAtPath(dir, noGh)).toBe("acme/widgets")
  })

  test("returns null for a directory that is not a git checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-test-"))

    expect(await resolveRepoAtPath(dir, noGh)).toBeNull()
  })
})

describe("resolveScope", () => {
  test("returns the repo and an absolute directory for a checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-test-"))
    await execa("git", ["init", "-q"], { cwd: dir })
    await execa("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir })

    const scope = await resolveScope(dir, noGh)

    expect(scope.repo).toBe("acme/widgets")
    expect(isAbsolute(scope.dir)).toBe(true)
  })

  test("rejects a path that does not exist, naming the path", async () => {
    const missing = join(tmpdir(), "ops-hud-test-does-not-exist")

    expect(resolveScope(missing, noGh)).rejects.toThrow(missing)
  })

  test("rejects a directory that has no GitHub remote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-test-"))

    expect(resolveScope(dir, noGh)).rejects.toThrow(/GitHub/)
  })
})

describe("config path migration", () => {
  // Existing gh-hud users must not silently lose their configuration to the
  // rename; the new name wins, the old one still works.
  test("reads a legacy .gh-hud.json when no new config exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-"))
    await writeFile(join(dir, ".gh-hud.json"), JSON.stringify({ maxWorkflows: 7 }))
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, dir, await freshHome())
    expect(manager.maxWorkflows).toBe(7)
  })

  test("prefers .ops-hud.json when both exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-"))
    await writeFile(join(dir, ".gh-hud.json"), JSON.stringify({ maxWorkflows: 7 }))
    await writeFile(join(dir, ".ops-hud.json"), JSON.stringify({ maxWorkflows: 9 }))
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, dir, await freshHome())
    expect(manager.maxWorkflows).toBe(9)
  })
})

describe("config home directory", () => {
  test("home-relative paths resolve against the given home, not the real one", async () => {
    const base = await mkdtemp(join(tmpdir(), "ops-hud-"))
    const home = await freshHome()
    await writeFile(join(home, ".ops-hud.json"), JSON.stringify({ maxWorkflows: 11 }))
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, base, home)
    expect(manager.maxWorkflows).toBe(11)
  })

  test("a legacy file in the given home is read when nothing newer exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "ops-hud-"))
    const home = await freshHome()
    await writeFile(join(home, ".gh-hud.json"), JSON.stringify({ maxWorkflows: 13 }))
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, base, home)
    expect(manager.maxWorkflows).toBe(13)
  })
})

describe("retired config keys", () => {
  test("an old config with filterStatus still loads, and the key is ignored", async () => {
    const base = await mkdtemp(join(tmpdir(), "ops-hud-"))
    await writeFile(
      join(base, ".ops-hud.json"),
      JSON.stringify({ maxWorkflows: 4, filterStatus: ["in_progress", "queued"] }),
    )
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, base, await freshHome())
    expect(manager.maxWorkflows).toBe(4)
    expect("filterStatus" in manager.getConfig()).toBe(false)
  })
})

describe("loaded config path", () => {
  test("records which file was loaded, so a shadowed legacy file is visible", async () => {
    const base = await mkdtemp(join(tmpdir(), "ops-hud-"))
    await writeFile(join(base, ".gh-hud.json"), JSON.stringify({ maxWorkflows: 7 }))
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, base, await freshHome())
    expect(manager.loadedPath).toBe(join(base, ".gh-hud.json"))
  })
})

describe("showCompletedFor", () => {
  const withSetting = (value: unknown) => {
    const manager = new ConfigManager()
    manager.updateFromArgs({ showCompletedFor: value as number })
    return manager.showCompletedFor
  }

  // 0 means "no history on launch". A `||` fallback would silently turn it
  // back into the default.
  test("keeps a deliberate 0", () => {
    expect(withSetting(0)).toBe(0)
  })

  test("defaults to 60 minutes", () => {
    expect(new ConfigManager().showCompletedFor).toBe(60)
    expect(withSetting(undefined)).toBe(60)
  })

  test("ignores a negative or non-numeric value", () => {
    expect(withSetting(-5)).toBe(60)
    expect(withSetting("30")).toBe(60)
  })

  test("keeps any other number", () => {
    expect(withSetting(15)).toBe(15)
  })
})

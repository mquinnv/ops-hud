import { describe, expect, test } from "bun:test"
import buildsFixture from "../fixtures/buildkite-builds.json"
import pipelinesFixture from "../fixtures/buildkite-pipelines.json"
import {
  type BuildkiteBuildPayload,
  indexPipelinesByRepo,
  mapBuildkiteBuild,
  mapBuildkiteJob,
} from "./buildkite-map.js"

const [rawBuild, failingBuild, blockedBuild] = buildsFixture as unknown as BuildkiteBuildPayload[]

describe("mapBuildkiteBuild", () => {
  test("produces a buildkite-provider run keyed by repo and build uuid", () => {
    const run = mapBuildkiteBuild(rawBuild)
    expect(run.provider).toBe("buildkite")
    expect(run.id).toBe(rawBuild.id)
    expect(run.key).toBe(`buildkite:${run.repo.fullName}:${run.id}`)
  })

  test("derives the repository from the pipeline's git remote", () => {
    const run = mapBuildkiteBuild(rawBuild)
    expect(run.repo.fullName).toMatch(/^[^/]+\/[^/]+$/)
    expect(run.repo.fullName).not.toContain(".git")
  })

  test("carries the pipeline slug needed by the write endpoints", () => {
    expect(mapBuildkiteBuild(rawBuild).pipelineSlug).toBe(rawBuild.pipeline.slug)
  })

  // Buildkite's `message` is the full commit message; these are routinely
  // many paragraphs long in this org.
  test("takes the title from the first line and keeps the full message", () => {
    const build = { ...rawBuild, message: "short subject\n\nlong body" }
    const run = mapBuildkiteBuild(build)
    expect(run.title).toBe("short subject")
    expect(run.commitMessage).toBe("short subject\n\nlong body")
  })

  test("marks a failing build as running-but-doomed", () => {
    const run = mapBuildkiteBuild(failingBuild)
    expect(failingBuild.state).toBe("failing")
    expect(run.status).toBe("running")
    expect(run.isFailing).toBe(true)
  })

  test("surfaces blocked builds as blocked", () => {
    expect(blockedBuild.state).toBe("blocked")
    expect(mapBuildkiteBuild(blockedBuild).status).toBe("blocked")
  })

  // A build that is merely queued/passed/blocked is not "running-but-doomed" —
  // isFailing must stay false unless the build's own state says `failing`.
  test("does not flag a passed or blocked build as failing", () => {
    expect(rawBuild.state).toBe("passed")
    expect(mapBuildkiteBuild(rawBuild).isFailing).toBe(false)
    expect(blockedBuild.state).toBe("blocked")
    expect(mapBuildkiteBuild(blockedBuild).isFailing).toBe(false)
  })

  test("embeds jobs into the run's own key space", () => {
    const run = mapBuildkiteBuild(rawBuild)
    const job = mapBuildkiteJob(rawBuild.jobs[0], run.key)
    expect(job.runKey).toBe(run.key)
    expect(job.steps).toBeUndefined()
  })

  // Ruling C: Run.event carries what kicked the build off — Buildkite's
  // `source` under GitHub's name. The blocked fixture build is scheduled.
  test("carries the trigger source through as event", () => {
    expect(blockedBuild.source).toBe("schedule")
    expect(mapBuildkiteBuild(blockedBuild).event).toBe("schedule")
  })

  // Ruling E: the real API returns null (not absent) for creator; it must
  // come out undefined, never null, on the neutral model.
  test("normalises a null creator to an undefined actor", () => {
    expect(blockedBuild.creator).toBeNull()
    expect(mapBuildkiteBuild(blockedBuild).actor).toBeUndefined()
  })

  // Fix round 1, item 2: a pipeline whose remote is not GitHub (or otherwise
  // fails to parse) must not fall back to `slug/slug` by accident — owner
  // must be explicitly empty and name/fullName the slug.
  test("falls back to an explicit repo when the pipeline's remote is not GitHub", () => {
    const build = {
      ...rawBuild,
      pipeline: {
        ...rawBuild.pipeline,
        slug: "some-pipeline",
        repository: "git@gitlab.com:acme/widgets.git",
      },
    }
    const run = mapBuildkiteBuild(build)
    expect(run.repo).toEqual({ owner: "", name: "some-pipeline", fullName: "some-pipeline" })
    expect(run.key).toBe(`buildkite:some-pipeline:${run.id}`)
  })
})

describe("mapBuildkiteJob", () => {
  test("keeps the command, since Buildkite jobs have no steps", () => {
    const job = mapBuildkiteJob(rawBuild.jobs[0], "buildkite:acme/widgets:x")
    expect(job.steps).toBeUndefined()
    expect(job.id).toBe(rawBuild.jobs[0].id)
    expect(job.command).toBe(rawBuild.jobs[0].command)
  })

  // Ruling B: Job.key is now required, composed as `${runKey}:${id}` because
  // native job ids are only unique within a provider.
  test("gives the job a key composed from the run key and native id", () => {
    const job = mapBuildkiteJob(rawBuild.jobs[0], "buildkite:acme/widgets:x")
    expect(job.key).toBe(`buildkite:acme/widgets:x:${rawBuild.jobs[0].id}`)
  })

  test("preserves the job type so manual gates can be rendered", () => {
    const job = mapBuildkiteJob({ ...rawBuild.jobs[0], type: "manual", state: "blocked" }, "k")
    expect(job.type).toBe("manual")
    expect(job.status).toBe("blocked")
  })

  // Ruling D: `:gradle: test + explode, build + push image` renders as an
  // icon in Buildkite's UI but shows as literal text on a narrow terminal
  // card, so shortcode tokens are stripped and the leftover whitespace
  // collapsed.
  test("strips emoji shortcodes from a job name", () => {
    const job = mapBuildkiteJob(
      { ...rawBuild.jobs[0], name: ":gradle: test + explode, build + push image" },
      "k",
    )
    expect(job.name).toBe("test + explode, build + push image")
  })

  // Fix round 1, item 1: adjacent shortcodes at the start of the name count
  // as a single token to strip.
  test("strips a run of adjacent shortcodes as one token", () => {
    const job = mapBuildkiteJob({ ...rawBuild.jobs[0], name: ":docker::k8s: deploy" }, "k")
    expect(job.name).toBe("deploy")
  })

  // A shortcode in the middle of the name is stripped too, and the
  // surrounding whitespace collapses to a single space.
  test("strips a shortcode in the middle of a name", () => {
    const job = mapBuildkiteJob({ ...rawBuild.jobs[0], name: "build :rocket: fast" }, "k")
    expect(job.name).toBe("build fast")
  })

  // A name that is *only* a shortcode would otherwise become an empty
  // string; fall back to the raw name instead.
  test("falls back to the raw name when stripping shortcodes leaves nothing", () => {
    const job = mapBuildkiteJob({ ...rawBuild.jobs[0], name: ":rocket:" }, "k")
    expect(job.name).toBe(":rocket:")
  })

  // Fix round 1, item 1 (the correctness bug): colon-namespaced job names and
  // plain timestamps are common in CI and must survive completely unchanged
  // — the old regex matched any colon-delimited segment, not just whole
  // whitespace-delimited shortcode tokens.
  test("leaves colon-namespaced and timestamp-like names untouched", () => {
    expect(mapBuildkiteJob({ ...rawBuild.jobs[0], name: "12:30:45" }, "k").name).toBe("12:30:45")
    expect(mapBuildkiteJob({ ...rawBuild.jobs[0], name: "deploy:prod:us-east" }, "k").name).toBe(
      "deploy:prod:us-east",
    )
    expect(mapBuildkiteJob({ ...rawBuild.jobs[0], name: "a:b:c" }, "k").name).toBe("a:b:c")
  })

  // The blocked fixture's manual job has a `label` but no `name`, and
  // `command`/`agent` are explicitly null — exactly the case ruling D and E
  // exist for.
  test("cleans the label of a manual job that has no name, and normalises its nulls", () => {
    const manualJob = blockedBuild.jobs[1]
    expect(manualJob.type).toBe("manual")
    expect(manualJob.name).toBeUndefined()
    expect(manualJob.command).toBeNull()
    expect(manualJob.agent).toBeNull()

    const job = mapBuildkiteJob(manualJob, blockedBuild.id)
    expect(job.name).toBe("rotate credential")
    expect(job.command).toBeUndefined()
    expect(job.agent).toBeUndefined()
  })

  // Ruling E: started_at/finished_at come back null while a job hasn't run
  // yet, never absent.
  test("normalises null started_at/finished_at to undefined", () => {
    const manualJob = blockedBuild.jobs[1]
    expect(manualJob.started_at).toBeNull()
    expect(manualJob.finished_at).toBeNull()

    const job = mapBuildkiteJob(manualJob, blockedBuild.id)
    expect(job.startedAt).toBeUndefined()
    expect(job.finishedAt).toBeUndefined()
  })
})

describe("indexPipelinesByRepo", () => {
  test("maps owner/repo to pipeline slugs", () => {
    const index = indexPipelinesByRepo(pipelinesFixture as never)
    expect(index.size).toBeGreaterThan(0)
    for (const [repo, slugs] of index) {
      expect(repo).toMatch(/^[^/]+\/[^/]+$/)
      expect(slugs.length).toBeGreaterThan(0)
    }
  })

  // Several pipelines can build the same repository; none may be lost. The
  // fixture itself exercises this: one pipeline points at
  // ameriglide/beejax-platform over SSH, another over HTTPS.
  test("collects every pipeline for a repository, including a mix of SSH and HTTPS remotes", () => {
    const index = indexPipelinesByRepo(pipelinesFixture as never)
    expect(index.get("ameriglide/beejax-platform")).toEqual([
      "beejax-platform-credential-check",
      "beejax-platform-media-webp-reconcile",
    ])
  })

  test("collects every pipeline for a repository (synthetic case)", () => {
    const index = indexPipelinesByRepo([
      { slug: "a", name: "A", repository: "git@github.com:acme/widgets.git" },
      { slug: "b", name: "B", repository: "https://github.com/acme/widgets" },
    ] as never)
    expect(index.get("acme/widgets")).toEqual(["a", "b"])
  })

  test("ignores pipelines whose remote is not GitHub", () => {
    const index = indexPipelinesByRepo([
      { slug: "x", name: "X", repository: "git@gitlab.com:acme/widgets.git" },
    ] as never)
    expect(index.size).toBe(0)
  })
})

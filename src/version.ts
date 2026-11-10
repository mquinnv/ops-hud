import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * This package's version. The pane and the poller daemon both derive the
 * socket name from it, so they must read it the same way.
 */
export function readPackageVersion(): string {
  return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")).version
}

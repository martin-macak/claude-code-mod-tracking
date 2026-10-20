import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

// What the harness needs of node to run the fake `gh` (support/fake-gh.ts): where the shim lives, and the environment
// that puts it first on the PATH of claude.

/** Where the shim lives. `bin/` holds `gh` alone, so putting it on PATH adds no other command. */
export const FAKE_GH_DIR = fileURLToPath(new URL('../fake-gh', import.meta.url))

/**
 * The variables that make claude run the fake: the shim dir first on PATH, and the two files it reads and writes.
 * `env(1)` adds variables and never removes one, so the two GitHub tokens are set empty: a token of the caller must not
 * give claude a credential for the fake repo. An empty value is the nearest to unset that `env(1)` allows.
 */
export function fakeGhEnv(
  files: { specFile: string; logFile: string },
  basePath: string = process.env.PATH ?? '',
): Record<string, string> {
  return {
    PATH: [`${FAKE_GH_DIR}/bin`, ...(basePath === '' ? [] : [basePath])].join(delimiter),
    FAKE_GH_SPEC: files.specFile,
    FAKE_GH_LOG: files.logFile,
    // The node that runs the harness, so the shim needs no node on the PATH of claude.
    FAKE_GH_NODE: process.execPath,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  }
}

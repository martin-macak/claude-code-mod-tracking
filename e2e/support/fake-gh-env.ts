import { fileURLToPath } from 'node:url'
import { fakeCliEnv } from './fake-cli-env.ts'

// What the harness needs of node to run the fake `gh` (support/fake-gh.ts): where the shim lives, and the environment
// that puts it first on the PATH of claude.

/** Where the shim lives. `bin/` holds `gh` alone, so putting it on PATH adds no other command. */
export const FAKE_GH_DIR = fileURLToPath(new URL('../fake-gh', import.meta.url))

/**
 * The variables that make claude run the fake: the shim dir first on PATH, and the two files it reads and writes.
 * The two GitHub tokens are set empty: a token of the caller must not give claude a credential for the fake repo.
 */
export function fakeGhEnv(
  files: { specFile: string; logFile: string },
  basePath: string = process.env.PATH ?? '',
): Record<string, string> {
  return fakeCliEnv('GH', FAKE_GH_DIR, files, basePath, ['GH_TOKEN', 'GITHUB_TOKEN'])
}

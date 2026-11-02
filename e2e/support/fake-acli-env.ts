import { fileURLToPath } from 'node:url'
import { fakeCliEnv } from './fake-cli-env.ts'

// What the harness needs of node to run the fake `acli` (support/fake-acli.ts): where the shim lives, and the environment
// that puts it first on the PATH of claude.

/** Where the shim lives. `bin/` holds `acli` alone, so putting it on PATH adds no other command. */
export const FAKE_ACLI_DIR = fileURLToPath(new URL('../fake-acli', import.meta.url))

/**
 * The variables that make claude run the fake: the shim dir first on PATH, and the two files it reads and writes. `basePath`
 * is the PATH to extend: pass the PATH of the fake gh when both run, or the second shim hides the first.
 * The Atlassian tokens are set empty: a token of the caller must not give claude a credential for Jira. The fake reads no
 * credential and no acli config, so this is a second guard.
 */
export function fakeAcliEnv(
  files: { specFile: string; logFile: string },
  basePath: string = process.env.PATH ?? '',
): Record<string, string> {
  return fakeCliEnv('ACLI', FAKE_ACLI_DIR, files, basePath, ['ATLASSIAN_API_TOKEN', 'JIRA_API_TOKEN', 'ACLI_API_TOKEN'])
}

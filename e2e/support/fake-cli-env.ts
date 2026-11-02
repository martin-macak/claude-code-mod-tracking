import { delimiter } from 'node:path'

// The environment that puts a fake CLI (fake `gh`, fake `acli`) first on the PATH of claude. One copy, so a change of the
// PATH rule or of the token rule is made once.

/**
 * The variables that make claude run the fake `<name>`: its shim dir first on PATH, and the files and the node it uses,
 * as `FAKE_<PREFIX>_SPEC`, `_LOG` and `_NODE`. `basePath` is the PATH to extend: pass the PATH of another fake when both
 * run, or the second shim hides the first. `env(1)` adds variables and never removes one, so each name in `emptyTokens` is
 * set empty, the nearest to unset that `env(1)` allows: a token of the caller must not give claude a credential.
 */
export function fakeCliEnv(
  prefix: string,
  shimDir: string,
  files: { specFile: string; logFile: string },
  basePath: string,
  emptyTokens: readonly string[],
): Record<string, string> {
  return {
    PATH: [`${shimDir}/bin`, ...(basePath === '' ? [] : [basePath])].join(delimiter),
    [`FAKE_${prefix}_SPEC`]: files.specFile,
    [`FAKE_${prefix}_LOG`]: files.logFile,
    // The node that runs the harness, so the shim needs no node on the PATH of claude.
    [`FAKE_${prefix}_NODE`]: process.execPath,
    ...Object.fromEntries(emptyTokens.map(t => [t, ''])),
  }
}

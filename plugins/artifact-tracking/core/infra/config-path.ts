// The path rule of the config file. `CLAUDE_TRACKER_CONFIG_DIR`, when set and absolute, is the whole folder
// (like `GH_CONFIG_DIR`). Else `XDG_CONFIG_HOME` when set, non-empty and absolute. Else `<HOME>/.config`.
// With no absolute `HOME` and no override there is no path: the mod runs on defaults and never writes.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 3 (decision C9).
// Also the default place of the debug log of Claude Code (`resolveDebugLog`), which the count line of the config problems
// names (issue #144).

import type { EnvName } from '../interfaces/ports'
import { show } from '../lib/normalise'

/** The path under the base folder. */
export const CONFIG_TAIL = 'claude-code/mods/tracker/config.json'

type Env = { get(name: EnvName): Promise<string | undefined> }

/** The value when it is non-empty and absolute, without trailing slashes. */
const absolute = (v: string | undefined): string | undefined => (v?.startsWith('/') ? v.replace(/\/+$/, '') : undefined)

/** The value of a name, or undefined when it is unset or the read rejects. */
async function readEnv(env: Env, name: EnvName): Promise<string | undefined> {
  try {
    return await env.get(name)
  } catch {
    return undefined
  }
}

/**
 * Where the config file lives. Each name is read once and a rejection counts as unset. A relative override gives
 * one problem and the rule falls through. A relative or empty `XDG_CONFIG_HOME` falls through with no problem (XDG).
 */
export async function resolveConfigPath(env: Env): Promise<{ path?: string; problems: readonly string[] }> {
  const read = (name: EnvName): Promise<string | undefined> => readEnv(env, name)
  const problems: string[] = []
  const override = await read('CLAUDE_TRACKER_CONFIG_DIR')
  const dir = absolute(override)
  if (dir !== undefined) return { path: `${dir}/config.json`, problems }
  if (override)
    problems.push(`CLAUDE_TRACKER_CONFIG_DIR is not an absolute path: ${show(override)}. The mod ignores it.`)
  const xdg = absolute(await read('XDG_CONFIG_HOME'))
  if (xdg !== undefined) return { path: `${xdg}/${CONFIG_TAIL}`, problems }
  const home = absolute(await read('HOME'))
  return home === undefined ? { problems } : { path: `${home}/.config/${CONFIG_TAIL}`, problems }
}

/**
 * The default place of the debug log of Claude Code: `debug/latest` in the Claude config folder, which is
 * `CLAUDE_CONFIG_DIR` when set and absolute, else `<HOME>/.claude` (issue #144). The mod cannot read the path of the log in
 * use, and the file exists only when `claude` starts with `--debug`. A run with `--debug-file <path>` writes to `<path>`,
 * so this is the default place and no more. Each name is read once and a rejection counts as unset. With no absolute
 * folder there is no place and the result is undefined.
 */
export async function resolveDebugLog(env: Env): Promise<string | undefined> {
  const dir = absolute(await readEnv(env, 'CLAUDE_CONFIG_DIR'))
  if (dir !== undefined) return `${dir}/debug/latest`
  const home = absolute(await readEnv(env, 'HOME'))
  return home === undefined ? undefined : `${home}/.claude/debug/latest`
}

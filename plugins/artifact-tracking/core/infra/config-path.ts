// The path rule of the config file. `CLAUDE_TRACKER_CONFIG_DIR`, when set and absolute, is the whole folder
// (like `GH_CONFIG_DIR`). Else `XDG_CONFIG_HOME` when set, non-empty and absolute. Else `<HOME>/.config`.
// With no absolute `HOME` and no override there is no path: the mod runs on defaults and never writes.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 3 (decision C9).

import type { EnvName } from '../interfaces/ports'
import { show } from '../lib/normalise'

/** The path under the base folder. */
export const CONFIG_TAIL = 'claude-code/mods/tracker/config.json'

type Env = { get(name: EnvName): Promise<string | undefined> }

/** The value when it is non-empty and absolute, without trailing slashes. */
const absolute = (v: string | undefined): string | undefined => (v?.startsWith('/') ? v.replace(/\/+$/, '') : undefined)

/**
 * Where the config file lives. Each name is read once and a rejection counts as unset. A relative override gives
 * one problem and the rule falls through. A relative or empty `XDG_CONFIG_HOME` falls through with no problem (XDG).
 */
export async function resolveConfigPath(env: Env): Promise<{ path?: string; problems: readonly string[] }> {
  const read = async (name: EnvName): Promise<string | undefined> => {
    try {
      return await env.get(name)
    } catch {
      return undefined
    }
  }
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

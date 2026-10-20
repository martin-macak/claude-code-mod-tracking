// The version of the mod, read from its manifest: `<plugin root>/.claude-plugin/plugin.json`. The engine gives no
// version (its plugin identity has only a name and a root), so the mod reads the file it ships in. A manifest it cannot
// read, parse or find a version in gives "unknown" with the reason, and the mod works as before. Never rejects. Pure over
// the ports. Issue #65. Spike: the engine's file read of that path works from a loaded plugin (headless
// `claude -p --plugin-dir`, Claude Code 2.1.304), and in the kit only through a stub of the read.

import type { Ports } from '../interfaces/ports'
import { isRecord } from '../lib/json'
import { reason } from './steps'

/** What `/track version`, the help view and the debug log say when the manifest gives no version. */
export const UNKNOWN = 'unknown'

/** The manifest, relative to the plugin root. */
export const MANIFEST_PATH = '.claude-plugin/plugin.json'

/** The version, and why it is `unknown` when it is. */
export interface VersionRead {
  readonly version: string
  /** Set only when `version` is `unknown`: one short phrase for the debug log. */
  readonly problem?: string
}

const unknown = (problem: string): VersionRead => ({ version: UNKNOWN, problem })

/** Reads the `version` of the manifest. The root is read inside the guard: a refused plugin identity must not stop the start. */
export async function readVersion(p: { fs: Pick<Ports['fs'], 'read'>; plugin: Ports['plugin'] }): Promise<VersionRead> {
  let text: string
  try {
    text = await p.fs.read(`${p.plugin.root}/${MANIFEST_PATH}`)
  } catch (e) {
    return unknown(`cannot read the manifest: ${reason(e)}`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return unknown('the manifest is not valid JSON')
  }
  const version = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version.trim() : ''
  return version === '' ? unknown('the manifest has no version string') : { version }
}

/** Reads the manifest, hands the version to `keep` and writes the one debug line that names it (and why, when it is `unknown`). */
export async function announceVersion(
  p: { fs: Pick<Ports['fs'], 'read'>; plugin: Ports['plugin']; log: Ports['log'] },
  keep: (version: string) => void,
): Promise<void> {
  const { version, problem } = await readVersion(p)
  keep(version)
  p.log(problem === undefined ? `version: ${version}` : `version: ${version} (${problem})`)
}

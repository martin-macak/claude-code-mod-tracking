import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The layout of a probe plugin that the engine loads with an extra `--plugin-dir`: a manifest, a hooks file that names one
// module, and the module. A probe (support/copy-probe.ts, support/timer-refuser.ts) says only what differs: its name, its
// description, the name of its log and the text of its module. The folder of a plugin is watched, so the log lies beside it.

/** The files of a probe in a folder: the plugin and, beside it, the log. */
export type ProbePlugin = { readonly pluginDir: string; readonly logFile: string }

/** What makes one probe differ from another. `source` gets the path of the log and returns the text of the module. */
export type ProbeSpec = {
  readonly name: string
  readonly description: string
  readonly logName: string
  readonly source: (logFile: string) => string
}

/** Writes the probe plugin into `dir`, and says where its log will be. The log does not exist until the probe writes it. */
export function writeProbePlugin(dir: string, spec: ProbeSpec): ProbePlugin {
  const pluginDir = join(dir, 'plugin')
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true })
  const logFile = join(dir, spec.logName)
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: spec.name, version: '0.0.1', description: spec.description, author: { name: 'e2e' } })}\n`,
  )
  writeFileSync(join(pluginDir, 'hooks', 'hooks.json'), `${JSON.stringify({ modules: ['./register.ts'] })}\n`)
  writeFileSync(join(pluginDir, 'hooks', 'register.ts'), spec.source(logFile))
  return { pluginDir, logFile }
}

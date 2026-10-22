import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A probe plugin for the copy key of the questions tracker (issue #71, features/questions.feature). The key hands the call
// to the engine with `$.ui.copy`, and the engine writes the clipboard of the machine. The probe hears that `ui.copy` event
// as a plugin of its own, writes the text to a log (the last copy wins) and answers `{ isCopied: true }` without `next`, so the engine never
// writes the clipboard: the run leaves the clipboard of the person alone and the scenario can read what the key copied.
// The folder of a plugin is watched, so the log lies beside it, never in it.

/** The files of the probe in a folder: the plugin and, beside it, the log. */
export type CopyProbe = { readonly pluginDir: string; readonly logFile: string }

/** The module of the probe. The log path is in the text, so the probe reads no environment. */
export function probeSource(logFile: string): string {
  return [
    '// Test probe of the e2e harness: answers ui.copy so that the clipboard is never written, and logs what the key copied.',
    'export const register = on => {',
    "  on('ui.copy', async ($, e) => {",
    `    await $.fs.write(${JSON.stringify(logFile)}, \`\${JSON.stringify(e.text)}\\n\`)`,
    '    return { value: { isCopied: true } }',
    '  })',
    '}',
    '',
  ].join('\n')
}

/** Writes the probe plugin into `dir`, and says where its log will be. The log does not exist until the probe hears a copy. */
export function writeCopyProbe(dir: string): CopyProbe {
  const pluginDir = join(dir, 'plugin')
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true })
  const logFile = join(dir, 'copy.log')
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'copy-probe', version: '0.0.1', description: 'e2e probe: answers ui.copy', author: { name: 'e2e' } })}\n`,
  )
  writeFileSync(join(pluginDir, 'hooks', 'hooks.json'), `${JSON.stringify({ modules: ['./register.ts'] })}\n`)
  writeFileSync(join(pluginDir, 'hooks', 'register.ts'), probeSource(logFile))
  return { pluginDir, logFile }
}

/** The text of the last copy that the probe heard, or undefined while it heard none. */
export function copiedText(logFile: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(logFile, 'utf8')
  } catch {
    return undefined
  }
  const line = raw.split('\n').find(l => l !== '')
  return line === undefined ? undefined : (JSON.parse(line) as string)
}

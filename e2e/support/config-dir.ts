import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

// The tracker config file in its folder, the CLAUDE_TRACKER_CONFIG_DIR of a scenario.
export const CONFIG_FILE = 'config.json'
const PREFIX = 'cc-tracker-config-'

// An empty folder for the tracker config of one scenario, made under `base`. The help view of the pane prints the path
// of the config file, and a long path wraps onto a row of its own. A scenario that counts the rows of the view needs a
// path of a known width, but the width of the temporary folder differs by system: `/var/folders/...` of a Mac is 85
// cells, `/tmp` is 40. With `cells`, the folder name takes the padding that gives `<folder>/config.json` that width.
// The folder is one level, so the caller removes it with one `rmSync`.
export function makeConfigDir(base: string, cells?: number): string {
  if (cells === undefined) return mkdtempSync(join(base, PREFIX))
  // mkdtemp adds 6 characters to the prefix.
  const plain = join(base, `${PREFIX}${'X'.repeat(6)}`, CONFIG_FILE).length
  if (cells < plain) {
    throw new Error(
      `config folder: the config file path is ${plain} cells wide already, in ${base}. The scenario asks for ${cells}. ` +
        'Set TMPDIR to a shorter folder.',
    )
  }
  return mkdtempSync(join(base, `${PREFIX}${'p'.repeat(cells - plain)}`))
}

// Why a scenario cannot set the width of the config file path now, or undefined when it can. The folder is the
// environment of the session, and the step that writes the config file writes into the folder as it is then.
export function pathWidthRefusal(state: { launched: boolean; written: boolean }): string | undefined {
  if (state.launched) return 'config file path: set its width before the step that starts the session'
  if (state.written) return 'config file path: set its width before the step that writes the config file'
  return undefined
}

import { readFileSync } from 'node:fs'

// The debug log of a session (`claude --debug-file`, issue #193). The mod writes a line there with `$.ui.log(text, { to:
// 'debug' })`, and the engine leads it with `[DEBUG] [<plugin>] $.ui.log (to debug): `. A scenario reads the file to see
// what the mod did that the screen does not show, for example that the wake of the ring pause ended a wait.

/** The text of the debug log, or undefined while the file does not exist. */
function read(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** True when some line of the debug log holds `text`, as it is (no pattern). False while the file is missing or empty. */
export function debugLogHolds(file: string, text: string): boolean {
  return read(file)?.includes(text) === true
}

/** The last `lines` lines of the debug log, for the message of a step that timed out. */
export function debugLogTail(file: string, lines: number): string {
  const raw = read(file)
  if (raw === undefined) return 'no debug log'
  const all = raw.split('\n').filter(Boolean)
  return all.length === 0 ? 'an empty debug log' : all.slice(-lines).join('\n')
}

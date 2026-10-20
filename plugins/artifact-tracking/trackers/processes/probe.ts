export type DockerProbeState = 'up' | 'exited' | 'unhealthy'

export function dockerStateFromStatus(status: string): DockerProbeState {
  const s = status.toLowerCase()
  if (s.includes('unhealthy')) return 'unhealthy'
  if (s.startsWith('up ')) return 'up'
  return 'exited'
}

export function parseDockerPs(stdout: string): Array<{ id: string; name: string; state: DockerProbeState }> {
  const out: Array<{ id: string; name: string; state: DockerProbeState }> = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [id, name, status] = line.split('\t')
    if (!id || !name || !status) continue
    out.push({ id, name, state: dockerStateFromStatus(status) })
  }
  return out
}

function idMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.startsWith(y) || y.startsWith(x)
}

/** By id, or by name: a `--name` row keeps working when the id from the Bash output was missing or wrong. */
export function dockerEntryMatchesRow(
  entry: { id: string; name: string },
  row: { name: string; containerId?: string },
): boolean {
  return idMatches(entry.id, row.containerId) || entry.name === row.name
}

/** One compose project from the `{{.Status}}` lines of its containers: any unhealthy, else any up, else exited. */
export function composeState(stdout: string): DockerProbeState {
  const states = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(dockerStateFromStatus)
  if (states.includes('unhealthy')) return 'unhealthy'
  return states.includes('up') ? 'up' : 'exited'
}

type Ran = { exitCode: number; stdout: string; stderr: string }

export function parseTmuxLs(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(l => /^([^:]+):/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
}

export function parseScreenLs(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(l => /^\s*\d+\.([^\s(]+)/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
}

/** Sessions from `tmux ls`. No server, or no socket folder yet, means no sessions. Other failures throw. */
export function tmuxLive(r: Ran): string[] {
  if (r.exitCode === 0) return parseTmuxLs(r.stdout)
  const err = r.stderr.toLowerCase()
  if (err.includes('no server running') || err.includes('error connecting to')) return []
  throw new Error(r.stderr.trim() || `tmux ls failed (${r.exitCode})`)
}

/**
 * Sessions from `screen -ls`. Screen exits 1 also when sessions exist, and writes the list to stdout,
 * so the exit code says nothing. Only a missing binary (127) or no list text at all is a failure.
 */
export function screenLive(r: Ran): string[] {
  const text = `${r.stdout}\n${r.stderr}`
  const live = parseScreenLs(text)
  if (live.length > 0 || r.exitCode === 0 || /no sockets found|\bsockets? in\b/i.test(text)) return live
  throw new Error(r.stderr.trim() || `screen -ls failed (${r.exitCode})`)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const LSTART = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})\s+/

/** Splits `lstart= command=` text. `start` is local epoch ms, undefined when the date does not parse. */
function splitLstart(line: string): { start?: number; command: string } {
  const m = LSTART.exec(line)
  if (!m) return { command: line.trim() }
  const month = MONTHS.indexOf(m[1]!.toLowerCase())
  const command = line.slice(m[0].length).trim()
  if (month === -1) return { command }
  const start = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime()
  return { start, command }
}

/** `python3` and `Python`, `node22` and `node`: the program without folder, case and version digits. */
const progKey = (w: string): string =>
  w
    .slice(w.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/[\d.]+$/, '')

// A variable the parser could not expand: `$NAME`, `${NAME}` or `$(...)`. `$5` and a lone `$` are not one.
const VARIABLE = '\\$(?:\\{[^}]*\\}|\\([^)]*\\)|[A-Za-z_][A-Za-z0-9_]*)'

const ANY_VARIABLE = new RegExp(VARIABLE)
const EACH_VARIABLE = new RegExp(VARIABLE, 'g')

/** Does the fingerprint still name a variable? Then `ps` shows text in its place that the mod never saw. */
export const hasUnexpandedVariable = (fingerprint: string): boolean => ANY_VARIABLE.test(fingerprint)

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A word of a fingerprint with a variable: a pattern when it names one (a variable is any text), else the literal word. */
const toPattern = (word: string): RegExp | string =>
  hasUnexpandedVariable(word) ? new RegExp(`^${word.split(EACH_VARIABLE).map(escapeRe).join('.*')}$`) : word

/**
 * A fingerprint with a variable, against a `ps` command line. Each word is compared on its own, and a variable stands
 * for any text inside its word. A variable stands for one word: a value of several words shifts the words after it,
 * so nothing fits and the row shows `unknown`. The command may carry more words than the fingerprint, never fewer.
 * Because a variable may hide anything, this is a loose match (1), never an exact one.
 */
function looseStrength(cmd: readonly string[], fp: readonly (RegExp | string)[]): 0 | 1 {
  if (cmd.length < fp.length) return 0
  const ok = fp.every((word, i) => {
    if (typeof word !== 'string') return word.test(cmd[i]!)
    return i === 0 ? progKey(cmd[0]!) === progKey(word) : cmd[i] === word
  })
  return ok ? 1 : 0
}

/**
 * How well a `ps` command line matches the spawned command. 2: same program and arguments (an interpreter
 * may re-exec under another path, as python3 does on macOS). 1: the whole fingerprint appears as words
 * (a shebang script runs as `node ./script`), or a fingerprint with a variable fits word by word. 0: no match.
 */
type Strength = (command: string) => 0 | 1 | 2

/**
 * The comparison of one fingerprint with many command lines. It is built once per fingerprint: the patterns of a
 * fingerprint with a variable are compiled here, not for each `ps` line.
 */
function strengthOf(fingerprint: string): Strength {
  const fp = fingerprint.trim().split(/\s+/)
  if (fp[0] === '') return () => 0
  if (hasUnexpandedVariable(fingerprint)) {
    const patterns = fp.map(toPattern)
    return command => looseStrength(command.trim().split(/\s+/), patterns)
  }
  const fpArgs = fp.slice(1).join(' ')
  const fpLine = ` ${fp.join(' ')} `
  const program = progKey(fp[0]!)
  return command => {
    const cmd = command.trim().split(/\s+/)
    const cmdArgs = cmd.slice(1).join(' ')
    const argsOk = cmdArgs === fpArgs || (fpArgs !== '' && cmdArgs.startsWith(fpArgs + ' '))
    if (argsOk && progKey(cmd[0]!) === program) return 2
    return ` ${cmd.join(' ')} `.includes(fpLine) ? 1 : 0
  }
}

/**
 * Does the fingerprint say nothing but its program? `node $F` has only variables after `node`, so any process of that
 * program would fit. `node $D/s.js` keeps `/s.js` and is a constraint.
 */
const namesOnlyProgram = (fingerprint: string): boolean =>
  fingerprint
    .trim()
    .split(/\s+/)
    .slice(1)
    .every(word => word.replace(EACH_VARIABLE, '') === '')

/** Slack for `firstSeen`: ps prints whole seconds. */
const START_SLACK_MS = 2000
/** A Bash call runs at most 10 minutes, so its process started at most that long before the row was seen. */
const SPAWN_WINDOW_MS = 11 * 60_000

/**
 * Does `ps -p <pid> -o lstart=,command=` still show the spawned process? A process that started after the row
 * was first seen is another process on a reused pid.
 */
export function psStillMatches(stdout: string, fingerprint: string, firstSeen?: number): boolean {
  const line = stdout.trim()
  if (!line) return false
  const { start, command } = splitLstart(line)
  if (start !== undefined && firstSeen !== undefined && start > firstSeen + START_SLACK_MS) return false
  return strengthOf(fingerprint)(command) > 0
}

/**
 * Finds the pid of a detached process the Bash output did not name, in `ps -A -o pid=,lstart=,command=`.
 * Takes the best match that started in the Bash call's window; among equals, the newest. An older process with
 * the same command (a dev server of another project) is not ours. A fingerprint that names only its program and
 * variables (`node $F`) finds nothing: any process of that program would fit, so the pid would be a guess. With a pid
 * known (`psStillMatches`) the same fingerprint is enough.
 */
export function findDetachedPid(stdout: string, fingerprint: string, firstSeen: number): number | undefined {
  if (hasUnexpandedVariable(fingerprint) && namesOnlyProgram(fingerprint)) return undefined
  const strengthOfLine = strengthOf(fingerprint)
  let best: { pid: number; strength: number; start: number } | undefined
  for (const raw of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(raw)
    if (!m) continue
    const { start, command } = splitLstart(m[2]!)
    if (start === undefined || start > firstSeen + START_SLACK_MS || start < firstSeen - SPAWN_WINDOW_MS) continue
    const strength = strengthOfLine(command)
    if (strength === 0) continue
    if (!best || strength > best.strength || (strength === best.strength && start > best.start))
      best = { pid: Number(m[1]), strength, start }
  }
  return best?.pid
}

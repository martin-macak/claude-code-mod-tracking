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

/**
 * How well a `ps` command line matches the spawned command. 2: same program and arguments (an interpreter
 * may re-exec under another path, as python3 does on macOS). 1: the whole fingerprint appears as words
 * (a shebang script runs as `node ./script`). 0: no match.
 */
function matchStrength(command: string, fingerprint: string): 0 | 1 | 2 {
  const cmd = command.trim().split(/\s+/)
  const fp = fingerprint.trim().split(/\s+/)
  if (cmd.length === 0 || fp.length === 0 || fp[0] === '') return 0
  const cmdArgs = cmd.slice(1).join(' ')
  const fpArgs = fp.slice(1).join(' ')
  const argsOk = cmdArgs === fpArgs || (fpArgs !== '' && cmdArgs.startsWith(fpArgs + ' '))
  if (argsOk && progKey(cmd[0]!) === progKey(fp[0]!)) return 2
  return ` ${cmd.join(' ')} `.includes(` ${fp.join(' ')} `) ? 1 : 0
}

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
  return matchStrength(command, fingerprint) > 0
}

/**
 * Finds the pid of a detached process the Bash output did not name, in `ps -A -o pid=,lstart=,command=`.
 * Takes the best match that started in the Bash call's window; among equals, the newest. An older process with
 * the same command (a dev server of another project) is not ours.
 */
export function findDetachedPid(stdout: string, fingerprint: string, firstSeen: number): number | undefined {
  let best: { pid: number; strength: number; start: number } | undefined
  for (const raw of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(raw)
    if (!m) continue
    const { start, command } = splitLstart(m[2]!)
    if (start === undefined || start > firstSeen + START_SLACK_MS || start < firstSeen - SPAWN_WINDOW_MS) continue
    const strength = matchStrength(command, fingerprint)
    if (strength === 0) continue
    if (!best || strength > best.strength || (strength === best.strength && start > best.start))
      best = { pid: Number(m[1]), strength, start }
  }
  return best?.pid
}

import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Config = {
  record: boolean
  model: string
  /** The tmux socket of the run (`tmux -L`). */
  socket: string
  /** The folder of the run: the clone of the repo and the fake origin are in it. */
  dir: string
  cols: number
  rows: number
  typeDelayMs: number
  turnTimeoutMs: number
  screenTimeoutMs: number
  /** How long a scenario waits for the lock of a run that is still going. 0: fail at once. */
  lockWaitMs: number
  keep: boolean
}

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'artifact-tracking')
export const OUT_DIR = join(REPO_ROOT, 'e2e', 'out')
export const CLONE_NAME = 'claude-code-mod-tracking'
// One lock for the default tmux socket and folder: one scenario run at a time on this machine.
export const LOCK_DIR = join(tmpdir(), 'cc-demo-lock')
export const DEFAULT_SOCKET = 'cc-demo'
export const DEFAULT_DIR = '/tmp/cc-demo'

type Env = Record<string, string | undefined>

// A socket name is a file in the tmux folder and a folder of `e2e/out`: one plain name, no path, no leading dot.
// At most 64 characters: tmux puts the name in a unix socket path, which macOS limits to about 104 bytes.
const SOCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function socketName(env: Env): string {
  const raw = env.DEMO_SOCKET
  if (raw === undefined || raw === '') return DEFAULT_SOCKET
  if (!SOCKET_NAME.test(raw))
    throw new Error(
      `config: DEMO_SOCKET must be a socket name (1 to 64 characters: letters, digits, "." "_" "-", not starting with a symbol), got "${raw}"`,
    )
  return raw
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`config: ${name} must be a positive integer, got "${raw}"`)
  return value
}

function nonNegativeInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`config: ${name} must be a non-negative integer, got "${raw}"`)
  return value
}

export function loadConfig(env: Env = process.env): Config {
  const record = env.DEMO_RECORD === '1'
  const socket = socketName(env)
  // Resolved, so a trailing slash or a dot segment of the default folder is the default folder (`isPrivateRun` compares it).
  // A symlink to it is not seen: the folder may not exist yet, and the README says so.
  const base = resolve(env.DEMO_DIR || DEFAULT_DIR)
  // The clone of a private run is a folder of its socket: two sockets with one DEMO_DIR get two clones, and the lock of a
  // socket guards its clone too.
  const dir = isPrivateRun({ socket, dir: base, record }) ? join(base, socket) : base
  return {
    record,
    model: env.DEMO_MODEL || 'haiku',
    socket,
    dir,
    cols: positiveInt(env, 'DEMO_COLS', 120),
    rows: positiveInt(env, 'DEMO_ROWS', 36),
    typeDelayMs: positiveInt(env, 'DEMO_TYPE_DELAY_MS', 35),
    turnTimeoutMs: positiveInt(env, 'DEMO_TURN_TIMEOUT_S', 120) * 1000,
    screenTimeoutMs: positiveInt(env, 'DEMO_SCREEN_TIMEOUT_S', 20) * 1000,
    lockWaitMs: nonNegativeInt(env, 'DEMO_LOCK_WAIT_S', 30 * 60) * 1000,
    keep: env.DEMO_KEEP === '1',
  }
}

type Scope = Pick<Config, 'socket' | 'dir' | 'record'>

/**
 * A run is private when it has its own tmux socket and its own folder (issue #185): no other run kills its tmux server or
 * wipes its clone, so it needs no shared lock. One of the two is not enough, because the other one is still shared with every
 * run that has the default. A recording is never private: `make demo` renders `e2e/out/demo`.
 */
export function isPrivateRun({ socket, dir, record }: Scope): boolean {
  // Case does not count: tmux socket names and `/tmp` paths are one file on a Mac whatever the case. A false "default" only
  // sends a run to the shared lock, and that is safe. A folder inside the default folder is no private folder either.
  const defaultDir = DEFAULT_DIR.toLowerCase()
  const lowDir = dir.toLowerCase()
  return (
    !record && socket.toLowerCase() !== DEFAULT_SOCKET && lowDir !== defaultDir && !lowDir.startsWith(`${defaultDir}/`)
  )
}

/**
 * The lock folders a run takes, in order. A run that is not private takes the shared lock, and, when its socket is not the
 * default, the lock of its socket too: a private run on that socket holds only the lock of the socket, so the folder or the
 * recording mode of a run must not let it skip the exclusion of a socket. A private run takes no shared lock, so no run holds
 * one lock while it waits for a lock that a run behind it holds: there is no cycle.
 */
export function lockDirsOf(config: Scope, shared: string = LOCK_DIR): string[] {
  if (isPrivateRun(config)) return [`${shared}-${config.socket}`]
  return config.socket.toLowerCase() === DEFAULT_SOCKET ? [shared] : [shared, `${shared}-${config.socket}`]
}

/**
 * The run folder of one scenario (`scenario` is its slug): under `private/<socket>` for a private run, so no other socket wipes
 * it and no scenario slug (`demo` included) can be its parent.
 */
export function outDirOf(config: Scope, scenario: string, out: string = OUT_DIR): string {
  return isPrivateRun(config) ? join(out, 'private', config.socket, scenario) : join(out, scenario)
}

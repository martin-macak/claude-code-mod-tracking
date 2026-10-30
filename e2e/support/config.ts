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
const SOCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function socketName(env: Env): string {
  const raw = env.DEMO_SOCKET
  if (raw === undefined || raw === '') return DEFAULT_SOCKET
  if (!SOCKET_NAME.test(raw))
    throw new Error(
      `config: DEMO_SOCKET must be a socket name (letters, digits, "." "_" "-", not starting with a symbol), got "${raw}"`,
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
  return {
    record: env.DEMO_RECORD === '1',
    model: env.DEMO_MODEL || 'haiku',
    socket: socketName(env),
    // Resolved, so a trailing slash or a dot segment of the default folder is the default folder (`isPrivateRun` compares it).
    // A symlink to it is not seen: the folder may not exist yet, and the README says so.
    dir: resolve(env.DEMO_DIR || DEFAULT_DIR),
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
  return !record && socket !== DEFAULT_SOCKET && dir !== DEFAULT_DIR
}

/**
 * The lock folder of a run: the shared one, or, for a private run, one for its socket alone. A second run on the same private
 * socket would kill the tmux server of the first, so those two still wait for each other. Runs on other sockets do not.
 */
export function lockDirOf(config: Scope, shared: string = LOCK_DIR): string {
  return isPrivateRun(config) ? `${shared}-${config.socket}` : shared
}

/** The run folder of one scenario (`scenario` is its slug): under the socket name for a private run, so no other socket wipes it. */
export function outDirOf(config: Scope, scenario: string, out: string = OUT_DIR): string {
  return isPrivateRun(config) ? join(out, config.socket, scenario) : join(out, scenario)
}

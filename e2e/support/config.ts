import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Config = {
  record: boolean
  model: string
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
// One lock for the fixed tmux socket "cc-demo": one scenario run at a time on this machine.
export const LOCK_DIR = join(tmpdir(), 'cc-demo-lock')

type Env = Record<string, string | undefined>

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
    dir: env.DEMO_DIR || '/tmp/cc-demo',
    cols: positiveInt(env, 'DEMO_COLS', 120),
    rows: positiveInt(env, 'DEMO_ROWS', 36),
    typeDelayMs: positiveInt(env, 'DEMO_TYPE_DELAY_MS', 35),
    turnTimeoutMs: positiveInt(env, 'DEMO_TURN_TIMEOUT_S', 120) * 1000,
    screenTimeoutMs: positiveInt(env, 'DEMO_SCREEN_TIMEOUT_S', 20) * 1000,
    lockWaitMs: nonNegativeInt(env, 'DEMO_LOCK_WAIT_S', 30 * 60) * 1000,
    keep: env.DEMO_KEEP === '1',
  }
}

// The process probe: one look at docker, tmux, screen and ps for the rows that are tracked. Moved out of
// hooks/register.tsx. It writes the states it found to the slot and publishes the probe's state as the fact
// `processes.ui`, which the pane and the `/track` text read. Plan: L3 Task 8.

import type { Json } from '../../core/interfaces/items'
import type { TrackerContext } from '../../core/interfaces/tracker'
import type { CircuitBreaker } from '../../core/lib/circuit-breaker'
import type { ProcessRecord, ProcessUiState } from '../../hooks/contracts'
import {
  composeState,
  dockerEntryMatchesRow,
  findDetachedPid,
  parseDockerPs,
  psStillMatches,
  screenLive,
  tmuxLive,
} from './probe'
import { readRows, setProcesses } from './rows'

/** The fact that carries the probe's state. */
export const UI_FACT = 'processes.ui'

/** What the pane shows before the first probe. */
export const IDLE_UI: ProcessUiState = { breaker: 'closed' }

/** The tracker's state for one load: the breaker that stops probing after repeated failures. */
export interface ProbeState {
  readonly breaker: CircuitBreaker
}

type ProbeCtx = Pick<TrackerContext<{ probeTimeoutMs: number }, Json>, 'data' | 'tools' | 'clock' | 'facts' | 'config'>

/** A probe command ran and exited non-zero. Not a breaker failure. */
class ExitError extends Error {}

/** The probe state as the pane last saw it. */
export function uiOf(ctx: Pick<ProbeCtx, 'facts'>): ProcessUiState {
  return (ctx.facts.read(UI_FACT) as unknown as ProcessUiState | undefined) ?? IDLE_UI
}

const publish = (ctx: Pick<ProbeCtx, 'facts'>, next: ProcessUiState): void =>
  ctx.facts.publish(UI_FACT, next as unknown as Json)

export async function probeProcesses(ctx: ProbeCtx, state: ProbeState): Promise<void> {
  const now = ctx.clock.wall()
  const { breaker } = state
  if (!breaker.allows(now)) {
    publish(ctx, { ...uiOf(ctx), breaker: 'open', openUntil: breaker.openUntil })
    return
  }
  const rows = await readRows(ctx)
  const of = (kind: ProcessRecord['kind']) => rows.filter(r => r.kind === kind)
  const dockerRows = of('docker-container')
  const composeRows = of('docker-compose')
  const tmuxRows = of('tmux')
  const screenRows = of('screen')
  const pidRows = of('detached-process').filter(r => r.pid !== undefined)
  const lostRows = of('detached-process').filter(r => r.pid === undefined && r.fingerprint !== undefined)
  const opts = { timeoutMs: ctx.config.slice().probeTimeoutMs }
  const run = (tool: string, ...args: string[]) => ctx.tools.run(tool, [tool, ...args], opts)
  const updates = new Map<string, Partial<ProcessRecord>>()
  const mark = (r: ProcessRecord, state: ProcessRecord['state'], pid?: number) => {
    if (r.state === state && (pid === undefined || r.pid === pid)) return
    updates.set(r.id, { state, ...(pid !== undefined ? { pid } : {}) })
  }
  // Each source is probed on its own: a Docker daemon that is down must not stop the tmux probe.
  // A failed source leaves its rows at their last known state. Only a thrown error (timeout, no binary) counts
  // for the breaker. A quick non-zero `docker ps` (daemon down) is shown as the reason and does not open it,
  // else after three ticks the open breaker would stop the tmux, screen and ps probes too.
  const failures: string[] = []
  let dockerError: string | undefined
  const probe = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!(e instanceof ExitError)) failures.push(msg)
      if (what === 'docker') dockerError = msg.includes('ENOENT') ? 'docker not installed' : msg.trim()
    }
  }

  if (dockerRows.length > 0 || composeRows.length > 0)
    await probe('docker', async () => {
      const ps = await run('docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}')
      if (ps.exitCode !== 0) throw new ExitError(ps.stderr.trim() || `docker ps failed (${ps.exitCode})`)
      const seen = parseDockerPs(ps.stdout)
      const found = new Map<string, ProcessRecord['state']>()
      for (const r of dockerRows) found.set(r.id, seen.find(x => dockerEntryMatchesRow(x, r))?.state ?? 'exited')
      for (const r of composeRows) {
        const label = `label=com.docker.compose.project=${r.project ?? r.name}`
        const listed = await run('docker', 'ps', '-a', '--filter', label, '--format', '{{.Status}}')
        if (listed.exitCode !== 0) throw new ExitError(listed.stderr.trim() || `docker ps failed (${listed.exitCode})`)
        found.set(r.id, composeState(listed.stdout))
      }
      for (const r of [...dockerRows, ...composeRows]) mark(r, found.get(r.id) as ProcessRecord['state'])
    })

  if (tmuxRows.length > 0)
    await probe('tmux', async () => {
      const live = new Set(tmuxLive(await run('tmux', 'ls')))
      for (const r of tmuxRows) mark(r, live.has(r.name) ? 'running' : 'exited')
    })

  if (screenRows.length > 0)
    await probe('screen', async () => {
      const live = new Set(screenLive(await run('screen', '-ls')))
      for (const r of screenRows) mark(r, live.has(r.name) ? 'running' : 'exited')
    })

  if (pidRows.length > 0)
    await probe('ps', async () => {
      for (const r of pidRows) {
        const out = await run('ps', '-p', String(r.pid), '-o', 'lstart=,command=')
        const alive = out.exitCode === 0 && psStillMatches(out.stdout, r.fingerprint ?? r.name, r.firstSeen)
        mark(r, alive ? 'running' : 'exited')
      }
    })

  // A detached process with no `echo $!` in its Bash call: find it once by command and start time.
  if (lostRows.length > 0)
    await probe('ps', async () => {
      const all = await run('ps', '-A', '-o', 'pid=,lstart=,command=')
      if (all.exitCode !== 0) throw new Error(all.stderr.trim() || `ps failed (${all.exitCode})`)
      for (const r of lostRows) {
        const pid = findDetachedPid(all.stdout, r.fingerprint as string, r.firstSeen)
        mark(r, pid !== undefined ? 'running' : 'exited', pid)
      }
    })

  if (updates.size > 0)
    await setProcesses(ctx, current => {
      const seenNow = ctx.clock.wall()
      let changed = false
      const merged = current.map(r => {
        const u = updates.get(r.id)
        if (u === undefined || (u.state === r.state && (u.pid === undefined || u.pid === r.pid))) return r
        changed = true
        return { ...r, ...u, lastSeen: seenNow }
      })
      return changed ? merged : current
    })
  if (failures.length > 0) breaker.failure(now)
  else breaker.success()
  const dockerProbed = dockerRows.length > 0 || composeRows.length > 0
  const prev = uiOf(ctx)
  publish(ctx, {
    ...prev,
    breaker: breaker.state,
    openUntil: breaker.openUntil,
    dockerIssue: dockerError ?? (dockerProbed ? undefined : prev.dockerIssue),
  })
}

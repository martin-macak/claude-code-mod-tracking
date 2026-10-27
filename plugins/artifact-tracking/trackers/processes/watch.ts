// The process probe: one look at docker, tmux, screen and ps for the rows that are tracked. Moved out of
// hooks/register.tsx. It writes the states it found to the slot and publishes the probe's state as the fact
// `processes.ui`, which the pane and the `/track` text read. Plan: L3 Task 8.

import type { Json } from '../../core/interfaces/items'
import type { Breaker, TrackerContext } from '../../core/interfaces/tracker'
import {
  composeState,
  dockerEntryMatchesRow,
  findDetachedPid,
  hasUnexpandedVariable,
  parseDockerPs,
  psStillMatches,
  screenLive,
  tmuxLive,
} from './probe'
import { readRows, setProcesses, withContainerGone, withState } from './rows'
import type { ProcessRecord, ProcessUiState } from './types'

/** The fact that carries the probe's state. */
export const UI_FACT = 'processes.ui'

/** What the pane shows before the first probe. */
export const IDLE_UI: ProcessUiState = { breaker: 'closed' }

/** The tracker's state for one load: the breaker that stops probing after repeated failures. */
export interface ProbeState {
  readonly breaker: Breaker
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
  // What a row changes in this probe: its state (and the pid a search found), and whether its container is gone. The mark
  // names the container that the probe judged: a row that holds another container by the time of the write is not marked.
  type Update = {
    state?: ProcessRecord['state']
    pid?: number
    gone?: { containerId: string; value: boolean }
  }
  const updates = new Map<string, Update>()
  const mark = (r: ProcessRecord, state: ProcessRecord['state'], pid?: number) => {
    if (r.state === state && (pid === undefined || r.pid === pid)) return
    updates.set(r.id, { ...updates.get(r.id), state, ...(pid !== undefined ? { pid } : {}) })
  }
  const markGone = (r: ProcessRecord, containerId: string, value: boolean) => {
    if ((r.containerGone === true) === value) return
    updates.set(r.id, { ...updates.get(r.id), gone: { containerId, value } })
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
      // Whether the container of a row still exists is a question of its id alone (issue #123, R8): a container of the same
      // name with another id is not it, and `ps -a --no-trunc` prints full ids. A row with no id is never marked. A failed
      // `ps` threw above, so a probe that learned nothing changes nothing. A listing that the runner cut may lack the line of a
      // container that exists, so it proves no absence: a cut listing leaves every mark as it was.
      const psIds = new Set(seen.map(x => x.id.toLowerCase()))
      if (ps.isStdoutTruncated !== true)
        for (const r of dockerRows)
          if (r.containerId !== undefined) markGone(r, r.containerId, !psIds.has(r.containerId.toLowerCase()))
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
        const fingerprint = r.fingerprint as string
        const pid = findDetachedPid(all.stdout, fingerprint, r.firstSeen)
        // A command with a variable the mod could not expand may fit no process because of its words alone: the state
        // is unknown then, not `exited`. A later probe may still find it.
        mark(r, pid !== undefined ? 'running' : hasUnexpandedVariable(fingerprint) ? 'unknown' : 'exited', pid)
      }
    })

  if (updates.size > 0)
    await setProcesses(ctx, current => {
      const seenNow = ctx.clock.wall()
      let changed = false
      const merged = current.map(r => {
        const u = updates.get(r.id)
        if (u === undefined) return r
        let next = r
        if (u.state !== undefined && (u.state !== r.state || (u.pid !== undefined && u.pid !== r.pid)))
          next = withState(r, u.state, seenNow, u.pid !== undefined ? { pid: u.pid } : {})
        if (u.gone !== undefined && r.containerId === u.gone.containerId) next = withContainerGone(next, u.gone.value)
        if (next !== r) changed = true
        return next
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

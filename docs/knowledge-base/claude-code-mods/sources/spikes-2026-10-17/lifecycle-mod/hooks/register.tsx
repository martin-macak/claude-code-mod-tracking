// Throwaway spike "lifecycle": R-Q5 (hot reload of core/), R-Q22 (session.end on /clear, /resume, /branch), R-Q9 (computed StateFamily id).
// Evidence: one file per event under OUT (name order = time order), plus one tick file per module copy.
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { XY } from '../core/x'
import { bump, peek, trackers } from '../trackers/a'

const REG = 'r2'
const GEN = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`
const LOADED_AT = Date.now()
const BASE = '<SPIKES>/live2-lifecycle'
const OUT = `${BASE}/out`

const markerRef = { plugin: 'lifecycle-mod', key: 'marker' } as const
const marker = atom(markerRef, '')

// Module variables: they start over at each reload. cmdCount shows whether they survive /clear, /resume, /branch.
let cmdCount = 0
let seq = 0
let pendingEnd = false
let lastSid = ''
let tickN = 0
let timerArmed = false

async function put($: EngineInterface, kind: string, data: Record<string, unknown>): Promise<void> {
  seq += 1
  const t = Date.now()
  const name = `${t}-${String(seq).padStart(3, '0')}-${GEN}-${kind.replace(/[^a-z0-9._-]/gi, '_')}.json`
  await $.fs.write(`${OUT}/${name}`, JSON.stringify({ t, gen: GEN, kind, cmdCount, ...data }))
}

async function sid($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch (err) {
    return `ERR ${String(err)}`
  }
}

async function snap($: EngineInterface): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { sid: await sid($) }
  try {
    out.marker = (await read($, marker)) ?? ''
  } catch (err) {
    out.marker = `ERR ${String(err)}`
  }
  try {
    out.github = await peek($, trackers[0]!)
    out.jira = await peek($, trackers[1]!)
  } catch (err) {
    out.family = `ERR ${String(err)}`
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spike-info', description: 'gen, core value, session id, state' })
      await $.command.register({ name: 'spike-mark', description: 'set marker atom [text] and bump family slots' })
      await $.command.register({ name: 'spike-fam', description: 'R-Q9: write and read family slots by tracker.id' })
      await $.command.register({ name: 'spike-var', description: 'bump the module variable cmdCount' })
    } catch (err) {
      await put($, 'register-failed', { err: String(err) })
    }
    await put($, 'session.start', { e, ...(await snap($)), core: XY, reg: REG })
    if (!timerArmed) {
      timerArmed = true
      // One tick file per module copy: a new file means a new copy, a stale mtime means a dead timer.
      $.clock.every(3000, async () => {
        tickN += 1
        try {
          await $.fs.write(`${OUT}/tick-${GEN}.json`, JSON.stringify({ gen: GEN, tickN, t: Date.now(), sid: await sid($), cmdCount, core: XY, reg: REG }))
        } catch {
          /* a dead timer shows as a stale file */
        }
      })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    pendingEnd = true
    const s = await snap($)
    await put($, 'session.end', { reason: e.reason, eSessionId: e.sessionId, resume: e.resume, ...s, budgetMs: next.budget.ms, remaining: next.budget.remainingMs })
    const r = await next(e)
    await put($, 'session.end.after-next', { ...(await snap($)) })
    return r
  })

  on('session.append', async ($, e, next) => {
    const id = await sid($)
    if (pendingEnd || id !== lastSid) {
      await put($, 'append-first', { pendingEnd, from: lastSid, door: e.door, origin: e.origin, role: e.message.role, ...(await snap($)) })
      pendingEnd = false
      lastSid = id
    }
    return next(e)
  })

  on('command.run', { command: 'spike-info' }, async $ => {
    cmdCount += 1
    const s = await snap($)
    const text = `gen=${GEN} core=${XY} reg=${REG} cmdCount=${cmdCount} ticks=${tickN} loadedAt=${LOADED_AT} snap=${JSON.stringify(s)}`
    await put($, 'info', { text })
    return { text }
  })

  on('command.run', { command: 'spike-var' }, async $ => {
    cmdCount += 100
    return { text: `cmdCount=${cmdCount} gen=${GEN}` }
  })

  on('command.run', { command: 'spike-mark' }, async ($, e) => {
    const value = e.args.trim() || `mark-${Date.now().toString(36)}`
    await update($, marker, () => value)
    for (const t of trackers) await bump($, t)
    const s = await snap($)
    await put($, 'mark', { value, ...s })
    return { text: `marker=${value} snap=${JSON.stringify(s)}` }
  })

  // R-Q9: ids come from tracker objects (github, jira) and from a bare string; read each back.
  on('command.run', { command: 'spike-fam' }, async ($, e) => {
    const lines: string[] = []
    for (const t of trackers) {
      const n = await bump($, t)
      const back = (await $.state.get({ plugin: 'lifecycle-mod', key: 'slots', id: t.id } as const)).value
      lines.push(`${t.id}: bump->${n} get=${JSON.stringify(back)}`)
    }
    const extra = e.args.trim()
    if (extra) {
      const ref = { plugin: 'lifecycle-mod', key: 'slots', id: extra } as const
      await update($, ref, s => ({ n: (s?.n ?? 0) + 10 }))
      lines.push(`${extra}: get=${JSON.stringify((await $.state.get(ref)).value)}`)
    }
    await put($, 'fam', { lines })
    return { text: lines.join(' | ') }
  })
}

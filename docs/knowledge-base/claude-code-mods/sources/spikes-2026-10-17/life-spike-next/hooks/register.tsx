// Throwaway spike "life": G05 ($.fs under HOME), G07 (session.end on /clear), G12 (events before a hot reload),
// G18 ($.fs.write atomicity, stat resolution). One question per command. Evidence goes to OUT as one file per event.
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

// Module variables: they start over at each reload. GEN names this copy of the module.
const VERSION = 'v5'
const WATCH_ALL = true
const GEN = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`
const OUT = '<SPIKES>/live-life/out'

const markerRef = { plugin: 'life-spike', key: 'marker' } as const
const marker = atom(markerRef, '')

let seq = 0
// A ring of the last event names this copy saw (WATCH_ALL only).
const ring: string[] = []
let ringBusy = false
let lastSid = ''
let ringDirty = false

// One file per event: no read-modify-write race between copies or hooks.
async function put($: EngineInterface, kind: string, data: Record<string, unknown>): Promise<void> {
  seq += 1
  const t = Date.now()
  const name = `${t}-${String(seq).padStart(3, '0')}-${GEN}-${kind.replace(/[^a-z0-9._-]/gi, '_')}.json`
  await $.fs.write(`${OUT}/${name}`, JSON.stringify({ t, gen: GEN, ver: VERSION, kind, ...data }, null, 1))
}

async function sid($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch (err) {
    return `ERR ${String(err)}`
  }
}

async function markerNow($: EngineInterface): Promise<{ value: string | undefined; version: number } | string> {
  try {
    const s = await $.state.get(markerRef)
    return { value: s.value, version: s.version }
  } catch (err) {
    return `ERR ${String(err)}`
  }
}

// G05 + G18 part 1: $.fs on $HOME/.config/claude-code/mods/tracker-spike/config.json.
async function spikeFs($: EngineInterface): Promise<string> {
  const out: string[] = []
  const home = await $.env.get('HOME')
  out.push(`HOME=${home}`)
  if (!home) return out.concat('no HOME').join('\n')
  const dir = `${home}/.config/claude-code/mods/tracker-spike`
  const file = `${dir}/config.json`
  const run = async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const t = Date.now()
    try {
      const v = await fn()
      out.push(`${name}: ok (${Date.now() - t} ms) ${JSON.stringify(v)}`)
      return v
    } catch (err) {
      out.push(`${name}: FAIL (${Date.now() - t} ms) ${String(err)}`)
      return undefined
    }
  }
  await run('exists(dir) before', () => $.fs.exists(dir))
  await run('exists(file) before', () => $.fs.exists(file))
  const body = JSON.stringify({ spike: 'life', n: 1 })
  await run('write(file)', () => $.fs.write(file, body))
  await run('exists(file) after', () => $.fs.exists(file))
  const back = await run('read(file)', () => $.fs.read(file))
  out.push(`read-back equals written: ${back === body}`)
  const nowMs = await $.clock.now()
  const st = await run('stat(file)', () => $.fs.stat(file))
  if (st) out.push(`clock.now - mtimeMs = ${nowMs - st.mtimeMs} ms`)
  await run('list(dir)', () => $.fs.list(dir))
  // Stat resolution: ten writes with no delay between them, stat after each.
  const mtimes: number[] = []
  for (let i = 0; i < 10; i++) {
    await $.fs.write(file, JSON.stringify({ spike: 'life', n: i + 2 }))
    const s = await $.fs.stat(file)
    mtimes.push(s.mtimeMs)
  }
  out.push(`mtimeMs after 10 writes: ${JSON.stringify(mtimes)}`)
  out.push(`distinct mtimes: ${new Set(mtimes).size}; any fractional ms: ${mtimes.some(m => m % 1 !== 0)}; any whole second: ${mtimes.some(m => m % 1000 === 0)}`)
  await run('write second dir-depth file', () => $.fs.write(`${dir}/sub/deeper/x.txt`, 'x'))
  await run('stat(dir) kind', () => $.fs.stat(dir))
  return out.join('\n')
}

// G18: 1 MiB writes, with a reader in the same process racing the writer for `ms` milliseconds.
// mode `shrink`: the writer alternates 1 MiB and 4 KiB, so a truncate or a short state would show as another length.
async function spikeRace($: EngineInterface, ms: number, mode: string): Promise<string> {
  const home = await $.env.get('HOME')
  const file = `${home}/.config/claude-code/mods/tracker-spike/${mode === 'shrink' ? 'shrink' : 'big'}.txt`
  const MIB = 1_048_576
  const SMALL = 4096
  const fill = (c: string, n: number) => c.repeat(n - 1) + '\n'
  await $.fs.write(file, fill('a', MIB))
  const end = Date.now() + ms
  let writes = 0
  const tally = { reads: 0, empty: 0, small: 0, partial: 0, fullUniform: 0, fullMixed: 0, errors: 0, errSample: '' }
  const writer = async () => {
    let i = 0
    while (Date.now() < end) {
      const c = String.fromCharCode(97 + (i % 26))
      await $.fs.write(file, mode === 'shrink' && i % 2 === 1 ? fill(c, SMALL) : fill(c, MIB))
      writes += 1
      i += 1
    }
  }
  const reader = async () => {
    while (Date.now() < end) {
      try {
        const text = await $.fs.read(file)
        tally.reads += 1
        if (text.length === 0) tally.empty += 1
        else if (text.length === SMALL) tally.small += 1
        else if (text.length !== MIB) tally.partial += 1
        else if (text.slice(0, MIB - 1) === text[0]?.repeat(MIB - 1)) tally.fullUniform += 1
        else tally.fullMixed += 1
      } catch (err) {
        tally.errors += 1
        tally.errSample = String(err)
      }
    }
  }
  await Promise.all([writer(), reader()])
  const st = await $.fs.stat(file)
  return `in-process race ${mode} ${ms} ms: writes=${writes} ${JSON.stringify(tally)} final size=${st.size}`
}

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: 'life', title: 'Life spike', focus: true, closeOnEscape: true })
  await put($, 'pane-open', { opened })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spike-fs', description: 'G05/G18: $.fs under HOME, stat resolution' })
      await $.command.register({ name: 'spike-race', description: 'G18: 1 MiB write vs read race [ms]' })
      await $.command.register({ name: 'spike-mark', description: 'G07: set $.state marker and $.store mark' })
      await $.command.register({ name: 'spike-info', description: 'Show gen, version, session id, marker' })
      await $.command.register({ name: 'spike-pane', description: 'G12: open the pane' })
      await $.command.register({ name: 'spike-timer', description: 'G12: arm a timer [ms]' })
      await $.command.register({ name: 'spike-clean', description: 'Delete the spike store keys' })
    } catch (err) {
      await put($, 'register-failed', { err: String(err) })
    }
    await put($, 'session.start', { e, sid: await sid($), marker: await markerNow($) })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await put($, 'classic.SessionStart', { source: e.source, sid: await sid($), marker: await markerNow($) })
    return next(e)
  })

  // G07: what a session.end hook sees on /clear, and how long $.store.set and $.fs.write take there.
  on('session.end', async ($, e, next) => {
    const t0 = Date.now()
    const rec: Record<string, unknown> = {
      reason: e.reason,
      eSessionId: e.sessionId,
      budgetMsAtStart: next.budget.ms,
      budgetRemainingAtStart: next.budget.remainingMs,
    }
    rec.sidInHook = await sid($)
    rec.marker = await markerNow($)
    const t1 = Date.now()
    try {
      await $.store.set('end-probe', { at: t1, sid: rec.sidInHook })
    } catch (err) {
      rec.storeErr = String(err)
    }
    const t2 = Date.now()
    try {
      await $.fs.write(`${OUT}/end-probe.txt`, `probe ${t2}`)
    } catch (err) {
      rec.fsErr = String(err)
    }
    const t3 = Date.now()
    try {
      rec.storeReadback = await $.store.get('end-probe')
    } catch (err) {
      rec.storeReadErr = String(err)
    }
    const t4 = Date.now()
    rec.ms = { stateAndSid: t1 - t0, storeSet: t2 - t1, fsWrite: t3 - t2, storeGet: t4 - t3 }
    rec.budgetRemainingAfterProbes = next.budget.remainingMs
    await put($, 'session.end', rec)
    const t5 = Date.now()
    const ended = await next(e)
    const t6 = Date.now()
    const after: Record<string, unknown> = { nextMs: t6 - t5, ended }
    after.sidAfterNext = await sid($)
    after.markerAfterNext = await markerNow($)
    after.budgetRemainingAfterNext = next.budget.remainingMs
    await put($, 'session.end.after-next', after)
    return ended
  })

  on('classic.SessionEnd', async ($, e, next) => {
    await put($, 'classic.SessionEnd', { reason: e.reason, sid: await sid($), marker: await markerNow($) })
    return next(e)
  })

  // Does the first row of a new conversation carry the new session id? Logged once per change.
  on('session.append', async ($, e, next) => {
    const id = await sid($)
    if (id !== lastSid) {
      await put($, 'sid-change', { from: lastSid, to: id, door: e.door, origin: e.origin, role: e.message.role })
      lastSid = id
    }
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    await put($, 'ui.close', { id: e.id, origin: e.origin })
    return next(e)
  })

  on('plugin.register', async ($, e, next) => {
    await put($, 'plugin.register', { name: e.name, tier: e.tier, version: e.version, provenance: e.provenance, uses: e.uses })
    return next(e)
  })

  if (WATCH_ALL) {
    // Every event this copy hears, newest 40 names in one file per copy. fs.* events are left out: the writes would loop.
    on('*', async ($, e, next) => {
      const name = next.event
      if (!name.startsWith('fs.')) {
        ring.push(`${Date.now()} ${name}`)
        if (ring.length > 60) ring.shift()
        if (ringBusy) {
          ringDirty = true
        } else {
          ringBusy = true
          try {
            do {
              ringDirty = false
              await $.fs.write(`${OUT}/ring-${GEN}.json`, JSON.stringify(ring, null, 1))
            } while (ringDirty)
          } finally {
            ringBusy = false
          }
        }
      }
      return next(e)
    })
  }

  on('command.run', { command: 'spike-fs' }, async $ => {
    const text = await spikeFs($)
    await put($, 'spike-fs', { text })
    return { text }
  })

  on('command.run', { command: 'spike-race' }, async ($, e) => {
    const parts = e.args.trim().split(/\s+/)
    const ms = Number(parts[0]) || 3000
    const text = await spikeRace($, ms, parts[1] ?? 'same')
    await put($, 'spike-race', { text })
    return { text }
  })

  on('command.run', { command: 'spike-mark' }, async $ => {
    const id = await sid($)
    const value = `mark-${Date.now().toString(36)}`
    await update($, marker, () => value)
    await $.store.set('mark', { value, sid: id })
    await put($, 'mark', { value, sid: id })
    return { text: `marker=${value} sid=${id}` }
  })

  on('command.run', { command: 'spike-info' }, async $ => {
    const id = await sid($)
    const now = await read($, marker)
    return { text: `gen=${GEN} ver=${VERSION} watchAll=${WATCH_ALL} sid=${id} marker=${JSON.stringify(now)}` }
  })

  on('command.run', { command: 'spike-pane' }, async $ => {
    await openPane($)
    return { text: `pane opened by gen=${GEN}` }
  })

  on('command.run', { command: 'spike-timer' }, async ($, e) => {
    const ms = Number(e.args.trim()) || 5000
    $.clock.after(ms, async () => {
      await put($, 'timer-fired', { armedMs: ms })
    })
    await put($, 'timer-armed', { ms })
    return { text: `timer ${ms} ms armed by gen=${GEN}` }
  })

  on('command.run', { command: 'spike-clean' }, async $ => {
    await $.store.delete('mark')
    await $.store.delete('end-probe')
    return { text: `store keys now: ${JSON.stringify(await $.store.keys())}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'life' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await read($, marker)
    return (
      <Box flexDirection="column">
        <Text>gen={GEN}</Text>
        <Text>ver={VERSION}</Text>
        <Text>marker={JSON.stringify(now)}</Text>
      </Box>
    )
  })
}

// R-REENTRY probe 2: on('tool.call') hook that runs $.tool.call (Read) again, capped. `/probe <mode>:<same|uniq>:<cap>`.
//   direct   nested call through the hook's own $
//   captured nested call through ports built from the command hook's $
//   timer    nested call from $.clock.after(0), own $, after the hook returned
//   peer     direct, plus a second hook B (matcher { tool: 'Read' }) that also calls per Read it sees
import type { EngineInterface, Register } from 'claude-code'

const WORK = '<SPIKES>/hl/work/f.txt'

type Ports = { read: (limit: number) => Promise<{ isError?: boolean; text?: string }>; after: (ms: number, fn: () => void) => unknown }
const rec: string[] = []
let cfg = { mode: 'direct', ident: 'same', cap: 3 }
let invA = 0
let invB = 0
let depthA = 0
let captured: Ports | undefined

function portsOf($: EngineInterface): Ports {
  return { read: limit => $.tool.call({ tool: 'Read', file_path: WORK, limit }) as never, after: (ms, fn) => $.clock.after(ms, fn) }
}

async function push($: EngineInterface, msg: string): Promise<void> {
  rec.push(msg)
  await $.store.set('rec', JSON.stringify(rec))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'run the tool.call re-entry probe' })
    return next(e)
  })

  on('command.run', { command: 'probe' }, async ($, e) => {
    captured = portsOf($)
    rec.length = 0
    invA = 0
    invB = 0
    depthA = 0
    const [mode = 'direct', ident = 'same', cap = '3'] = e.args.trim().split(':')
    cfg = { mode, ident, cap: Number(cap) }
    let outcome = ''
    try {
      const r = await $.tool.call({ tool: 'Read', file_path: WORK, limit: 100 })
      outcome = `isError=${String((r as { isError?: boolean }).isError)}`
    } catch (err) {
      outcome = 'REJECTED ' + String((err as { message?: string })?.message ?? err)
    }
    await $.clock.sleep(600)
    await push($, `cmd done ${outcome} invA=${invA} invB=${invB}`)
    await $.store.set('stats', JSON.stringify({ invA, invB }))
    return { text: `probe ${e.args.trim()} invA=${invA} invB=${invB}` }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Read') return next(e)
    const my = ++invA
    depthA++
    await push($, `A#${my} tool=${e.tool} limit=${String((e as { limit?: number }).limit)} depth=${depthA}`)
    const limit = cfg.ident === 'same' ? 100 : 100 + my
    const via: Ports = cfg.mode === 'captured' && captured ? captured : portsOf($)
    const nested = async (tag: string) => {
      try {
        const r = await via.read(limit)
        await push($, `A#${my} ${tag} nested returned isError=${String(r.isError)}`)
      } catch (err) {
        await push($, `A#${my} ${tag} nested REJECTED ${String((err as { message?: string })?.message ?? err)}`)
      }
    }
    if (cfg.mode === 'timer') {
      if (my <= cfg.cap) via.after(0, () => void nested('timer'))
    } else if (my <= cfg.cap) {
      await nested('direct')
    }
    const out = await next(e)
    depthA--
    await push($, `A#${my} done`)
    return out
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (cfg.mode !== 'peer') return next(e)
    const my = ++invB
    await push($, `B#${my} tool=${e.tool} limit=${String((e as { limit?: number }).limit)}`)
    if (my <= cfg.cap) {
      try {
        const r = await $.tool.call({ tool: 'Read', file_path: WORK, limit: 200 + my })
        await push($, `B#${my} nested returned isError=${String((r as { isError?: boolean }).isError)}`)
      } catch (err) {
        await push($, `B#${my} nested REJECTED ${String((err as { message?: string })?.message ?? err)}`)
      }
    }
    return next(e)
  })
}

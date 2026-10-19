// R-REENTRY probe 3: a cycle across two events. S (session.append) calls $.tool.call, T (tool.call) calls $.session.append.
// Both are capped at 6 as a watchdog only. `/probe a` starts with an append, `/probe r` with a Read.
import type { EngineInterface, Register } from 'claude-code'

const WORK = '<SPIKES>/hl/work/f.txt'
const CAP = 6
const rec: string[] = []
let invS = 0
let invT = 0

async function push($: EngineInterface, msg: string): Promise<void> {
  rec.push(msg)
  await $.store.set('rec', JSON.stringify(rec))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'cycle probe' })
    return next(e)
  })

  on('command.run', { command: 'probe' }, async ($, e) => {
    rec.length = 0
    invS = 0
    invT = 0
    if (e.args.trim() === 'a') {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'probe:start' }] } })
    } else {
      await $.tool.call({ tool: 'Read', file_path: WORK, limit: 50 })
    }
    await $.clock.sleep(600)
    await push($, `cmd done invS=${invS} invT=${invT}`)
    return { text: `cycle ${e.args.trim()} invS=${invS} invT=${invT}` }
  })

  on('session.append', async ($, e, next) => {
    const first = e.message.content[0]
    const text = first && first.type === 'text' ? first.text : '?'
    if (!text.startsWith('probe:')) return next(e)
    const my = ++invS
    await push($, `S#${my} saw append door=${e.door} text=${text}`)
    if (my <= CAP) {
      const r = await $.tool.call({ tool: 'Read', file_path: WORK, limit: 100 + my })
      await push($, `S#${my} Read returned isError=${String((r as { isError?: boolean }).isError)}`)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Read') return next(e)
    const my = ++invT
    await push($, `T#${my} saw Read limit=${String((e as { limit?: number }).limit)}`)
    if (my <= CAP) {
      const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `probe:t${my}` }] } })
      await push($, `T#${my} append returned ${r.deny === undefined ? 'stored' : 'deny'}`)
    }
    return next(e)
  })
}

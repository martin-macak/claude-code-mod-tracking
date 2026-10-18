// R-REENTRY probe: hooks that call $ again for the event they hook. Driven by `/probe <mode>:<same|uniq>:<before|after>:<cap>`.
//   direct   nested call through the hook's OWN $
//   captured nested call through a $ taken from the command hook (a different frame)
//   timer    nested call from $.clock.after(0) with the hook's own $, after the hook returned
//   peer     direct, plus a second hook B (door note) that also appends per row it sees
import type { EngineInterface, Register, SessionAppendArgs, SessionAppendResult } from 'claude-code'

const rec: string[] = []
let invA = 0
let invB = 0
let depthA = 0
type Ports = { append: (a: SessionAppendArgs) => Promise<SessionAppendResult>; after: (ms: number, fn: () => void) => unknown }
let captured: Ports | undefined

function portsOf($: EngineInterface): Ports {
  return { append: a => $.session.append(a), after: (ms, fn) => $.clock.after(ms, fn) }
}

async function push($: EngineInterface, msg: string): Promise<void> {
  rec.push(msg)
  await $.store.set('rec', JSON.stringify(rec))
}

function textOf(e: { message: { content: readonly { type: string; text?: string }[] } }): string {
  const first = e.message.content[0]
  return first && first.type === 'text' && typeof first.text === 'string' ? first.text : '?'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'run the re-entry probe' })
    return next(e)
  })

  on('command.run', { command: 'probe' }, async ($, e) => {
    captured = portsOf($)
    rec.length = 0
    invA = 0
    invB = 0
    depthA = 0
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `probe:${e.args.trim()}` }] } })
    await $.clock.sleep(600)
    await push($, `cmd done append=${r.deny === undefined ? 'stored' : 'deny'} invA=${invA} invB=${invB}`)
    await $.store.set('stats', JSON.stringify({ invA, invB }))
    return { text: `probe ${e.args.trim()} invA=${invA} invB=${invB}` }
  })

  on('session.append', async ($, e, next) => {
    const text = textOf(e)
    if (!text.startsWith('probe:')) return next(e)
    const [, mode, ident, order, capS] = text.split(':')
    const cap = Number(capS)
    const my = ++invA
    depthA++
    await push($, `A#${my} door=${e.door} origin=${JSON.stringify(e.origin).slice(0, 50)} depth=${depthA} text=${text}`)
    const body = ident === 'same' ? text : `probe:${mode}:${ident}:${order}:${capS}:n${my}`
    const via: Ports = mode === 'captured' && captured ? captured : portsOf($)
    const doAppend = async (who: Ports, tag: string) => {
      try {
        const r = await who.append({ message: { type: 'user', content: [{ type: 'text', text: body }] } })
        await push($, `A#${my} ${tag} append returned ${r.deny === undefined ? 'stored' : 'deny=' + r.deny}`)
      } catch (err) {
        await push($, `A#${my} ${tag} append REJECTED ${String((err as { message?: string })?.message ?? err)}`)
      }
    }
    if (mode === 'timer') {
      if (my <= cap) via.after(0, () => void doAppend(via, 'timer'))
      const out = await next(e)
      depthA--
      await push($, `A#${my} done`)
      return out
    }
    if (order === 'before' && my <= cap) await doAppend(via, 'before')
    const out = await next(e)
    if (order === 'after' && my <= cap) await doAppend(via, 'after')
    depthA--
    await push($, `A#${my} done`)
    return out
  }).catch((_$, e, next) => next(e))

  on('session.append', { door: 'note' }, async ($, e, next) => {
    const text = textOf(e)
    if (!text.startsWith('probe:peer')) return next(e)
    const cap = Number(text.split(':')[4])
    const my = ++invB
    await push($, `B#${my} door=${e.door} text=${text}`)
    if (my <= cap) {
      const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `probe:peer:uniq:before:${cap}:b${my}` }] } })
      await push($, `B#${my} append returned ${r.deny === undefined ? 'stored' : 'deny'}`)
    }
    return next(e)
  })
}

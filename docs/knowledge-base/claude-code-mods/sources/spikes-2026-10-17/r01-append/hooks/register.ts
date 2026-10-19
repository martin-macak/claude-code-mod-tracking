// R-REENTRY probe 1: on('session.append') hook that calls $.session.append once per invocation, capped.
// Row text format: probe:<same|uniq>:<before|after>:<cap>
import type { Register } from 'claude-code'

const rec: string[] = []
let inv = 0
let depth = 0
let maxDepth = 0

export const register: Register = on => {
  on('session.append', async ($, e, next) => {
    const first = e.message.content[0]
    const text = first && first.type === 'text' ? first.text : '?'
    if (!text.startsWith('probe:')) return next(e)
    const [, ident, order, capS] = text.split(':')
    const cap = Number(capS)
    inv++
    const my = inv
    depth++
    if (depth > maxDepth) maxDepth = depth
    rec.push(`inv${my} door=${e.door} origin=${e.origin.kind} text=${text} depth=${depth}`)
    await $.store.set('rec', JSON.stringify(rec))
    const body = ident === 'same' ? text : `probe:${ident}:${order}:${capS}:n${my}`
    const doAppend = async () => {
      try {
        const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: body }] } })
        rec.push(`inv${my} append-returned ${r.deny === undefined ? 'stored' : 'deny=' + r.deny}`)
      } catch (err) {
        rec.push(`inv${my} append-REJECTED ${String((err as { message?: string })?.message ?? err)}`)
      }
      await $.store.set('rec', JSON.stringify(rec))
    }
    if (order === 'before' && my <= cap) await doAppend()
    const out = await next(e)
    if (order === 'after' && my <= cap) await doAppend()
    rec.push(`inv${my} done`)
    depth--
    await $.store.set('stats', JSON.stringify({ inv, maxDepth }))
    await $.store.set('rec', JSON.stringify(rec))
    return out
  })
}

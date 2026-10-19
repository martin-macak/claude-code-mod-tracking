import { expect, test } from 'claude-code/testing'

test('session.end stores the probe and writes the record before the engine end step', async ($, on) => {
  const order: string[] = []
  const written: string[] = []
  on('session.id', () => ({ value: 'sess-A' }))
  on('fs.write', (_$, e) => {
    written.push(e.path)
    order.push('fs.write')
    return { value: undefined }
  })
  on('store.set', () => {
    order.push('store.set')
    return { value: undefined }
  })
  on('store.get', () => ({ value: { at: 1, sid: 'sess-A' } }))
  on('session.end', (_$, e) => {
    order.push('engine-end')
    return { sessionId: e.sessionId }
  })

  const done = await $.session.end({
    reason: 'clear',
    sessionId: 'sess-A',
    resume: { id: 'sess-A', cmd: 'claude --resume sess-A' } as never,
  })
  expect(done).toEqual({ sessionId: 'sess-A' })
  expect(written.some(p => p.includes('-session.end.json'))).toBe(true)
  expect(order.indexOf('store.set')).toBeLessThan(order.indexOf('engine-end'))
  expect(order.indexOf('fs.write')).toBeLessThan(order.indexOf('engine-end'))
})

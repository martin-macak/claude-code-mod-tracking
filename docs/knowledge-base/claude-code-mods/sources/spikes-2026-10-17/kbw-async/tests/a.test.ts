import { expect, test } from 'claude-code/testing'

test('a hook registered after an await fires', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(r).toEqual({ deny: 'async-registered' })
})

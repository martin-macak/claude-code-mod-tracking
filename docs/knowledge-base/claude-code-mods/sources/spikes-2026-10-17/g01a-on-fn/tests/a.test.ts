import { expect, test } from 'claude-code/testing'

test('hook registered in an imported file fires', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(r).toEqual({ deny: 'a-fired' })
})

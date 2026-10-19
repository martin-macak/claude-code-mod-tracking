import { expect, test } from 'claude-code/testing'

test('this.on hook fires', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: 'b-fired' })
})

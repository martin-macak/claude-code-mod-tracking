import { expect, test } from 'claude-code/testing'

test('renamed param hook fires', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: 'c-fired' })
})

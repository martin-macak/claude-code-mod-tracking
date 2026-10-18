import { expect, mock, test } from 'claude-code/testing'

test('$ passed to a plain function imported from a sibling file works at run time', async ($, on) => {
  mock.clock(on, { now: 7 })
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: 'k2:7' })
})

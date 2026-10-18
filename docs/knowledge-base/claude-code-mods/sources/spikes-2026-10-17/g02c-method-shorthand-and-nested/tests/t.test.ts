import { expect, mock, test } from 'claude-code/testing'

test('method-shorthand ports work', async ($, on) => {
  mock.clock(on, { now: 5 })
  mock.store(on)
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: '{"t":5}' })
})

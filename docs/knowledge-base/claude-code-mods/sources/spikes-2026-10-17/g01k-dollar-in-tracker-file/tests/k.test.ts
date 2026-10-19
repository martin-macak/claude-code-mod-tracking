import { expect, mock, test } from 'claude-code/testing'

test('tracker file helper takes $ and shared core is reached', async ($, on) => {
  mock.clock(on, { now: 42 })
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: 'k-fired:1:42' })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: 'k-fired:2:42' })
})

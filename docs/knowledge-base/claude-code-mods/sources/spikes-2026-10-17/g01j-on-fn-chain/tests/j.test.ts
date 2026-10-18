import { expect, test } from 'claude-code/testing'

test('two trackers registered through a chain both fire', async ($, on) => {
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.complete', () => ({ text: '' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: 'a-fired' })
  expect(await $.tool.call({ tool: 'Read', file_path: '/x' } as never)).toEqual({ deny: 'b-fired:sess-1' })
})

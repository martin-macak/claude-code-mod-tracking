import { expect, test } from 'claude-code/testing'

test('B off by default', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'x' } as never)).toEqual({ deny: 'a' })
  expect(await $.tool.call({ tool: 'Read', file_path: '/x' } as never)).toEqual({ result: 'engine' })
})
test('B on via options', { options: { withB: true } }, async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Read', file_path: '/x' } as never)).toEqual({ deny: 'b' })
})

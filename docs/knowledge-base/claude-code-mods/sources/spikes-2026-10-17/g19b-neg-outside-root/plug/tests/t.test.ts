import { expect, test } from 'claude-code/testing'

test('import above the plugin root', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Read', file_path: '/x' } as never)).toEqual({ deny: 'outside:41' })
})

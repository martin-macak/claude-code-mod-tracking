import { expect, test } from 'claude-code/testing'

test('register.ts imports ../core/*.ts (outside hooks/)', async ($, on) => {
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.call', () => ({ result: 'engine' }))
  expect(await $.tool.call({ tool: 'Read', file_path: '/x' } as never)).toEqual({ deny: 'direct:41' })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ deny: 'core:42:sess-1' })
})

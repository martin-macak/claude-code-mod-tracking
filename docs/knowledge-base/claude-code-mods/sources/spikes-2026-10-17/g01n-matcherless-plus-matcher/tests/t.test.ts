import { expect, test } from 'claude-code/testing'

test('two hooks on tool.call from two files', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  console.log('Bash ->', JSON.stringify(r))
  const r2 = await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  console.log('Read ->', JSON.stringify(r2))
  expect(r).toBeDefined()
})

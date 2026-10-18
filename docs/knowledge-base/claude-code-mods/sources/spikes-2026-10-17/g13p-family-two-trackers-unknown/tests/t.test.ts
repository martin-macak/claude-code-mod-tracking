import { expect, test } from 'claude-code/testing'

test('two family members, one key, separate values', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  const call = async (tool: string) => ((await $.tool.call({ tool, command: 'x', file_path: '/x' } as never)) as { deny: string }).deny
  expect(await call('Bash')).toBe('github={"n":1}')
  expect(await call('Bash')).toBe('github={"n":2}')
  expect(await call('Read')).toBe('jira={"n":1}')
})

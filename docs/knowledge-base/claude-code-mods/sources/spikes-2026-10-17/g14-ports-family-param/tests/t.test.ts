declare const console: { log(...a: unknown[]): void }
import { expect, test } from 'claude-code/testing'

test('family slots through a portsOf closure, id from a parameter', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  const r1 = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { deny: string }
  const r2 = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { deny: string }
  console.log('G14', r1.deny, '|', r2.deny)
  expect(r1.deny).toBe('github=1 jira=10')
  expect(r2.deny).toBe('github=2 jira=20')
})

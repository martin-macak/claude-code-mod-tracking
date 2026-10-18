declare const console: { log(...a: unknown[]): void }
import { expect, test } from 'claude-code/testing'

test('state refs from imported files', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  const r1 = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { deny: string }
  const r2 = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { deny: string }
  console.log(r1.deny, '|', r2.deny)
  expect(r2.deny).not.toBe(r1.deny)
})

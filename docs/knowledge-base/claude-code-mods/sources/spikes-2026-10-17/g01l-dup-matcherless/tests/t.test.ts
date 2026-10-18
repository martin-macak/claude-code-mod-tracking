import { expect, test } from 'claude-code/testing'

test('dup matcherless: does the kit load it', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  const r = await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(r).toBeDefined()
})

import { expect, test } from 'claude-code/testing'

test('hooks env has Intl.Segmenter, no Bun, no process', () => {
  const g = globalThis as Record<string, unknown>
  expect(typeof g.Intl).toBe('object')
  expect(typeof (g.Intl as { Segmenter?: unknown }).Segmenter).toBe('function')
  expect(typeof g.Bun).toBe('undefined')
  expect(typeof g.process).toBe('undefined')
  expect(new RegExp('^\\p{RGI_Emoji}$', 'v').test('\u{1F469}‍\u{1F373}')).toBe(true)
})

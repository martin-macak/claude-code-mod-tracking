// The budget guard: it counts what the engine counts, keeps the footer and falls back step by step. Pure.
import { expect, test } from 'claude-code/testing'
import { BUDGET, type Cost, fits, guard, measure } from '../ux/tree-data-table/budget'

interface Tree {
  type: string
  props: Record<string, unknown>
  children?: unknown[]
}

/** A tree of exactly `n` counted values and no characters: a Box with `n - 1` empty Texts. */
const valuesOf = (n: number): Tree => ({
  type: 'Box',
  props: {},
  children: Array.from({ length: Math.max(0, n - 1) }, () => ({ type: 'Text', props: {} })),
})

test('BUDGET is 15000 values and 80000 characters', () => {
  expect(BUDGET).toEqual({ values: 15000, chars: 80000 })
})

test('measure counts nodes and string children', () => {
  const tree = {
    type: 'Box',
    props: {},
    children: [
      { type: 'Text', props: {}, children: ['ab'] },
      { type: 'Button', props: { key: 'r0', label: '▸' } },
    ],
  }
  expect(measure(tree)).toEqual({ values: 4, chars: 3 })
})

test('measure counts a Box key, a Link href and label, not a Button key', () => {
  const tree = {
    type: 'Box',
    props: { key: 'k12' },
    children: [
      { type: 'Link', props: { href: 'https://a.b/c', label: 'x' } },
      { type: 'Button', props: { key: 'a-long-button-key', label: '' } },
      { type: 'Text', props: { key: 'ignored', color: 'success' } },
    ],
  }
  expect(measure(tree)).toEqual({ values: 4, chars: 3 + 13 + 1 })
})

// Issue #57, L2: the engine counts the source of a `Code` and the text of a `Markdown` in its 100,000 characters (a 120,000
// character `Code` drew 100,000 and cut the Buttons after it). The guard must count them, or a big file cuts the keys.
test('measure counts the source of a Code and the text of a Markdown, as the engine does', () => {
  const tree = {
    type: 'Box',
    props: {},
    children: [
      { type: 'Code', props: { source: 'abcde', path: 'a.ts', startLine: 1 } },
      { type: 'Markdown', props: { text: 'xy', dimColor: true } },
    ],
  }
  expect(measure(tree)).toEqual({ values: 3, chars: 7 })
  expect(measure({ type: 'Code', props: { source: 'x'.repeat(120_000) } })).toEqual({ values: 1, chars: 120_000 })
  // The language and the path are drawn nowhere and count nothing; a Code or Markdown with no text counts none.
  expect(measure({ type: 'Code', props: { language: 'typescript', path: 'long/path/a.ts' } })).toEqual({
    values: 1,
    chars: 0,
  })
  expect(measure({ type: 'Markdown', props: {} })).toEqual({ values: 1, chars: 0 })
})

test('a Code over the limit does not fit, so the guard falls back and the keys stay in the footer', () => {
  const footer = { type: 'Box', props: {}, children: [{ type: 'Button', props: { key: 'r', label: 'r: reload' } }] }
  const code = (n: number) => ({ type: 'Code', props: { source: 'x'.repeat(n) } })
  const { body, step } = guard<unknown>(footer, [() => code(120_000), () => code(10)], () => 'too large')
  expect(step).toBe(1)
  expect(body).toEqual(code(10))
  expect(guard<unknown>(footer, [() => code(120_000)], () => 'too large').body).toBe('too large')
})

test('measure walks lists, numbers and children of a Button', () => {
  const tree = {
    type: 'Box',
    props: {},
    children: [
      [{ type: 'Text', props: {}, children: ['a', ['b', 7]] }],
      { type: 'Button', props: { label: 'go' }, children: ['go'] },
    ],
  }
  // Box, Text, 'a', 'b', 7, Button, 'go' = 7 values; chars: a b 7 + (go label) + (go child) = 3 + 2 + 2
  expect(measure(tree)).toEqual({ values: 7, chars: 7 })
})

test('measure tolerates a missing props or children, a null node and a node with no string type', () => {
  expect(measure({ type: 'Box' })).toEqual({ values: 1, chars: 0 })
  expect(measure({ type: 'Link' })).toEqual({ values: 1, chars: 0 })
  expect(measure(null)).toEqual({ values: 0, chars: 0 })
  expect(measure(undefined)).toEqual({ values: 0, chars: 0 })
  expect(measure(true)).toEqual({ values: 0, chars: 0 })
  expect(measure({ type: () => null, props: {}, children: ['x'] })).toEqual({ values: 1, chars: 1 })
})

test('fits is true at the limit and false one above', () => {
  const limit: Cost = { values: 10, chars: 20 }
  expect(fits({ values: 10, chars: 20 }, limit)).toBe(true)
  expect(fits({ values: 11, chars: 20 }, limit)).toBe(false)
  expect(fits({ values: 10, chars: 21 }, limit)).toBe(false)
  expect(fits({ values: 0, chars: 0 }, limit)).toBe(true)
})

test('guard returns the first attempt that fits beside the footer', () => {
  const tried: number[] = []
  const attempt = (n: number) => () => {
    tried.push(n)
    return valuesOf(n)
  }
  const out = guard(valuesOf(20), [attempt(100), attempt(60), attempt(40), attempt(10)], () => valuesOf(1), {
    values: 70,
    chars: 1000,
  })
  expect(out.step).toBe(2)
  expect(measure(out.body).values).toBe(40)
  // attempts run lazily, in order, and stop at the first that fits
  expect(tried).toEqual([100, 60, 40])
})

test('guard reserves the footer first', () => {
  const limit: Cost = { values: 70, chars: 1000 }
  const alone = guard(valuesOf(0), [() => valuesOf(60)], () => valuesOf(1), limit)
  expect(alone.step).toBe(0)
  const beside = guard(valuesOf(20), [() => valuesOf(60)], () => valuesOf(1), limit)
  expect(beside.step).toBe(1)
})

test('guard reserves the footer characters too', () => {
  const footer = { type: 'Text', props: {}, children: ['x'.repeat(30)] }
  const body = (n: number) => ({ type: 'Text', props: {}, children: ['y'.repeat(n)] })
  const limit: Cost = { values: 100, chars: 50 }
  expect(guard(footer, [() => body(20)], () => body(0), limit).step).toBe(0)
  expect(guard(footer, [() => body(21)], () => body(0), limit).step).toBe(1)
})

test('guard falls back to tooLarge', () => {
  const lines = [() => valuesOf(100), () => valuesOf(90)]
  const sentinel: Tree = { type: 'Text', props: {}, children: ['too large'] }
  const out = guard(valuesOf(5), lines, () => sentinel, { values: 50, chars: 1000 })
  expect(out.step).toBe(lines.length)
  expect(out.body).toBe(sentinel)
})

test('guard with no attempt gives tooLarge, and the default limit is BUDGET', () => {
  expect(guard(valuesOf(1), [], () => 'x')).toEqual({ body: 'x', step: 0 })
  expect(guard(valuesOf(1), [() => valuesOf(BUDGET.values - 1)], () => valuesOf(1)).step).toBe(0)
  expect(guard(valuesOf(1), [() => valuesOf(BUDGET.values)], () => valuesOf(1)).step).toBe(1)
})

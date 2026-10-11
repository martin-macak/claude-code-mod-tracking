import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aggArgs,
  budgetError,
  GIF_BUDGET_BYTES,
  gifsicleArgs,
  leakError,
  normalizeGlyphs,
  redact,
} from '../render/render.ts'

test('redact blanks the plan name and usage notices with spaces of the same width', () => {
  const cast = redact({
    header: { version: 2, width: 80, height: 24 },
    events: [
      [0, 'o', 'Haiku 5.5 · Claude Max\r\n'],
      [1, 'o', "\u001b[33mYou've used 90% of your weekly limit · resets Mon\u001b[0m"],
      [2, 'i', 'Claude Max'],
    ],
  })
  assert.deepEqual(cast.events, [
    [0, 'o', `Haiku 5.5${' '.repeat(13)}\r\n`],
    [1, 'o', `\u001b[33m${' '.repeat(49)}\u001b[0m`],
    [2, 'i', 'Claude Max'],
  ])
})

test('redact catches a notice that asciinema split over two output events', () => {
  const cast = redact({
    header: { version: 2, width: 80, height: 24 },
    events: [
      [0, 'o', "ok\r\nYou've used 91% of yo"],
      [0.1, 'i', 'x'],
      [0.2, 'o', 'ur weekly limit · resets 12pm (Europe/Prague)\u001b[39m done'],
    ],
  })
  assert.deepEqual(cast.events, [
    [0, 'o', `ok\r\n${' '.repeat(21)}`],
    [0.1, 'i', 'x'],
    [0.2, 'o', `${' '.repeat('ur weekly limit · resets 12pm (Europe/Prague)'.length)}\u001b[39m done`],
  ])
})

test('redact blanks a usage notice cut short to a narrow column, and a lone reset time zone', () => {
  const cast = redact({
    header: { version: 2, width: 80, height: 24 },
    events: [[0, 'o', "You've used 91% of yo…\u001b[K\r\nresets 12pm (Europe/Prague) ·"]],
  })
  assert.deepEqual(cast.events, [[0, 'o', `${' '.repeat(22)}\u001b[K\r\n${' '.repeat(27)} ·`]])
})

const leakCast = (...data: string[]) => ({
  header: { version: 2 as const, width: 80, height: 24 },
  events: data.map((d, i): [number, string, string] => [i, 'o', d]),
})

test('leakError passes a clean cast', () => {
  assert.equal(leakError(leakCast('tracking GitHub 2 · Links 1', 'https://github.com/o/r/pull/1')), undefined)
})

test('leakError names a home path, an email and a plan name, also split or styled', () => {
  assert.match(leakError(leakCast('cwd /Users/al', 'ice/x')) ?? '', /\/Users\/alice/)
  assert.match(leakError(leakCast('me: a.b@example.com')) ?? '', /a\.b@example\.com/)
  assert.match(leakError(leakCast('Haiku · Claude \u001b[1mMax')) ?? '', /Claude Max/)
  assert.match(leakError(leakCast("You've used 91% of your limit")) ?? '', /used 91% of/)
})

test('normalizeGlyphs turns no-break spaces in output into spaces, which agg draws as a stray glyph', () => {
  const cast = normalizeGlyphs({
    header: { version: 2, width: 80, height: 24 },
    events: [
      [0, 'o', '❯\u00a0Note'],
      [1, 'i', '\u00a0'],
    ],
  })
  assert.deepEqual(cast.events, [
    [0, 'o', '❯ Note'],
    [1, 'i', '\u00a0'],
  ])
})

test('aggArgs ends with the input cast and the output gif', () => {
  const args = aggArgs('in.cast', 'out.gif')
  assert.deepEqual(args.slice(-2), ['in.cast', 'out.gif'])
  assert.equal(args[args.indexOf('--idle-time-limit') + 1], '5')
  assert.equal(args[args.indexOf('--fps-cap') + 1], '15')
})

test('gifsicleArgs optimises in place', () => {
  const args = gifsicleArgs('out.gif')
  assert.ok(args.includes('--batch'))
  assert.equal(args.at(-1), 'out.gif')
})

test('budgetError allows a GIF at the budget', () => {
  assert.equal(budgetError(GIF_BUDGET_BYTES), undefined)
})

test('budgetError names the size, the budget and the knobs above it', () => {
  const message = budgetError(GIF_BUDGET_BYTES + 1) ?? ''
  assert.match(message, /2\.00 MB, over the 2\.00 MB budget/)
  assert.match(message, /--fps-cap/)
})

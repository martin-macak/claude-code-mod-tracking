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

for (const plan of ['Ultra', 'Free']) {
  test(`redact blanks the ${plan} plan name`, () => {
    const cast = redact({
      header: { version: 2, width: 80, height: 24 },
      events: [[0, 'o', `Haiku 5.5 · Claude ${plan}\r\n`]],
    })
    assert.deepEqual(cast.events, [[0, 'o', `Haiku 5.5${' '.repeat(10 + plan.length)}\r\n`]])
  })

  test(`leakError flags the ${plan} plan name`, () => {
    assert.match(leakError(leakCast(`Haiku · Claude ${plan}`)) ?? '', new RegExp(`Claude ${plan}`))
  })
}

test('redact leaves a longer word after a plan name whole, and leakError ignores it', () => {
  const cast = redact({
    header: { version: 2, width: 80, height: 24 },
    events: [[0, 'o', 'Haiku · Claude Freedom']],
  })
  assert.deepEqual(cast.events, [[0, 'o', 'Haiku · Claude Freedom']])
  assert.equal(leakError(leakCast('Haiku · Claude Freedom')), undefined)
})

test('leakError flags the hook-skipped notices of a host plugin', () => {
  assert.match(leakError(leakCast('artifact-tracking: its session.append hook was skipped.')) ?? '', /hook was skipped/)
  assert.match(leakError(leakCast('"cc-plugin-sec-default" runs first and sent the event on')) ?? '', /runs first/)
  assert.match(leakError(leakCast('"cc-plugin-sec-default"')) ?? '', /cc-plugin-/)
})

test('redact blanks the free-uses count of the slash menu and the agents count of the footer', () => {
  const cast = redact({
    header: { version: 2, width: 80, height: 24 },
    events: [[0, 'o', '/ultrareview  3 free left ($5-$25 USD)\r\nesc · ← 3 agents\r\n']],
  })
  const text = (cast.events[0]?.[2] ?? '') as string
  assert.doesNotMatch(text, /free left|agents/)
  assert.equal(text.length, '/ultrareview  3 free left ($5-$25 USD)\r\nesc · ← 3 agents\r\n'.length)
  assert.equal(leakError(cast), undefined)
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

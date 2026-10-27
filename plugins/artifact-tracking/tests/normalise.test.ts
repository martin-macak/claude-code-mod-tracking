// The schema normaliser: the one rule set behind every config slice. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 1 (copy table N1 to N10).
import { expect, test } from 'claude-code/testing'
import {
  bool,
  deepFreeze,
  defaultsOf,
  enums,
  GLOB_MAX_LENGTH,
  globs,
  int,
  movedKeys,
  normaliseWith,
  obj,
  oneOf,
  show,
  specOf,
  WORD,
  words,
} from '../core/lib/normalise'

const S = {
  enabled: bool(true),
  n: int(50, 1, 100),
  w: words(['issue', 'bug'], 3),
  g: globs(['*.pem'], 3),
  o: obj({ t: int(3, 1, 10) }),
  mode: oneOf('off', ['off', 'text', 'full']),
  picks: enums(['a', 'b'], ['a', 'b', 'c', 'd']),
}

/** Normalises `raw` against `S` and returns the result with the problems it reported. */
function run(raw: unknown, path?: string) {
  const out: string[] = []
  const value = normaliseWith(S, raw, defaultsOf(S), w => void out.push(w), path)
  return { value, out }
}

test('an empty object gives the defaults and no problem', () => {
  const { value, out } = run({})
  expect(value).toEqual({
    enabled: true,
    n: 50,
    w: ['issue', 'bug'],
    g: ['*.pem'],
    o: { t: 3 },
    mode: 'off',
    picks: ['a', 'b'],
  })
  expect(out).toEqual([])
})

test('int: a string falls back to the default', () => {
  const { value, out } = run({ n: '60' })
  expect(value.n).toBe(50)
  expect(out).toEqual(['n: "60" is not a number. Using 50.'])
})

test('int: a float falls back to the default', () => {
  const { value, out } = run({ n: 1.5 })
  expect(value.n).toBe(50)
  expect(out).toEqual(['n: 1.5 is not a whole number. Using 50.'])
})

test('int: below the min clamps', () => {
  const { value, out } = run({ n: -4 })
  expect(value.n).toBe(1)
  expect(out).toEqual(['n: -4 is below the min 1. Using 1.'])
})

test('int: above the max clamps', () => {
  const { value, out } = run({ n: 5000 })
  expect(value.n).toBe(100)
  expect(out).toEqual(['n: 5000 is above the max 100. Using 100.'])
})

test('int: the bounds themselves are valid', () => {
  expect(run({ n: 1 }).out).toEqual([])
  expect(run({ n: 100 }).value.n).toBe(100)
})

test('int: null, NaN and Infinity are not numbers', () => {
  expect(run({ n: null }).out).toEqual(['n: null is not a number. Using 50.'])
  expect(run({ n: Number.NaN }).value.n).toBe(50)
  expect(run({ n: Number.POSITIVE_INFINITY }).value.n).toBe(50)
})

test('bool: a string falls back to the default', () => {
  const { value, out } = run({ enabled: 'false' })
  expect(value.enabled).toBe(true)
  expect(out).toEqual(['enabled: "false" is not true or false. Using true.'])
  expect(run({ enabled: false }).value.enabled).toBe(false)
})

test('words: lowercased, deduped, bad items left out, capped', () => {
  const { value, out } = run({ w: ['Ticket', 'ticket', 'two words', 'a', 'b', 'c'] })
  expect(value.w).toEqual(['ticket', 'a', 'b'])
  expect(out).toEqual([
    'w: "two words" is not a valid word. The mod leaves it out.',
    'w: the list has more than 3 words. The mod uses the first 3.',
  ])
})

test('words: a string is not a list and gives the default list', () => {
  const { value, out } = run({ w: 'issue' })
  expect(value.w).toEqual(['issue', 'bug'])
  expect(out).toEqual(['w: "issue" is not a list of words. Using the default list.'])
})

test('words: an empty list is valid and stays empty', () => {
  const { value, out } = run({ w: [] })
  expect(value.w).toEqual([])
  expect(out).toEqual([])
})

test('words: a number or a too long word is a bad item', () => {
  const { value, out } = run({ w: [7, 'a'.repeat(33), '1abc', 'ok-1'] })
  expect(value.w).toEqual(['ok-1'])
  expect(out).toEqual([
    'w: 7 is not a valid word. The mod leaves it out.',
    `w: "${'a'.repeat(33)}" is not a valid word. The mod leaves it out.`,
    'w: "1abc" is not a valid word. The mod leaves it out.',
  ])
})

test('words: the rule for a word is the WORD pattern', () => {
  expect(WORD.test('issue')).toBe(true)
  expect(WORD.test('a-b-1')).toBe(true)
  expect(WORD.test('Issue')).toBe(false)
  expect(WORD.test('-x')).toBe(false)
})

// Issue #57, L2: `file.secretPaths` holds globs (`*.vault`, `~/keys/**`), which no `words` rule takes: a glob has dots, stars and slashes.
test('globs: each string kept as written, case too, each once, in the order given; the default list is a copy', () => {
  const { value, out } = run({ g: ['*.Vault', '~/keys/**', '*.Vault'] })
  expect(value.g).toEqual(['*.Vault', '~/keys/**'])
  expect(out).toEqual([])
  const defaults = defaultsOf(S)
  expect(defaults.g).toEqual(['*.pem'])
  expect(defaults.g).not.toBe((S.g as { def: readonly string[] }).def)
})

test('globs: an item that is no string, an empty one, a long one and one with a control character are left out, each with a problem', () => {
  const long = 'x'.repeat(GLOB_MAX_LENGTH + 1)
  const { value, out } = run({ g: [7, '', long, 'a\u0000b', 'ok'] })
  expect(value.g).toEqual(['ok'])
  expect(out).toEqual([
    'g: 7 is not a valid glob. The mod leaves it out.',
    'g: "" is not a valid glob. The mod leaves it out.',
    `g: ${show(long)} is not a valid glob. The mod leaves it out.`,
    'g: "a\\u0000b" is not a valid glob. The mod leaves it out.',
  ])
  expect(run({ g: ['x'.repeat(GLOB_MAX_LENGTH)] }).value.g).toEqual(['x'.repeat(GLOB_MAX_LENGTH)])
})

test('globs: a string is not a list and gives the default list; an empty list is valid; a list over the cap is cut', () => {
  const text = run({ g: '*.pem' })
  expect(text.value.g).toEqual(['*.pem'])
  expect(text.out).toEqual(['g: "*.pem" is not a list of globs. Using the default list.'])
  expect(run({ g: [] }).value.g).toEqual([])
  const many = run({ g: ['a', 'b', 'c', 'd'] })
  expect(many.value.g).toEqual(['a', 'b', 'c'])
  expect(many.out).toEqual(['g: the list has more than 3 globs. The mod uses the first 3.'])
})

test('enums: a list of the listed words, in the order given, each once; the default list is a copy', () => {
  const { value, out } = run({ picks: ['d', 'a', 'd', 'c'] })
  expect(value.picks).toEqual(['d', 'a', 'c'])
  expect(out).toEqual([])
  const defaults = defaultsOf(S).picks as string[]
  expect(defaults).toEqual(['a', 'b'])
  defaults.push('x')
  expect(defaultsOf(S).picks).toEqual(['a', 'b'])
})

test('enums: a word that is not listed is left out with one problem each, as written (no case folding)', () => {
  const { value, out } = run({ picks: ['a', 'B', 7, 'zzz', 'c'] })
  expect(value.picks).toEqual(['a', 'c'])
  expect(out).toEqual([
    'picks: "B" is not one of a, b, c, d. The mod leaves it out.',
    'picks: 7 is not one of a, b, c, d. The mod leaves it out.',
    'picks: "zzz" is not one of a, b, c, d. The mod leaves it out.',
  ])
})

test('enums: a value that is no list, a list with no word left and an empty list give the default list', () => {
  const none = run({ picks: ['x', 'y'] })
  expect(none.value.picks).toEqual(['a', 'b'])
  expect(none.out).toEqual([
    'picks: "x" is not one of a, b, c, d. The mod leaves it out.',
    'picks: "y" is not one of a, b, c, d. The mod leaves it out.',
    'picks: no listed word is left. Using the default list.',
  ])
  const text = run({ picks: 'a' })
  expect(text.value.picks).toEqual(['a', 'b'])
  expect(text.out).toEqual(['picks: "a" is not a list of a, b, c, d. Using the default list.'])
  const empty = run({ picks: [] })
  expect(empty.value.picks).toEqual(['a', 'b'])
  expect(empty.out).toEqual(['picks: no listed word is left. Using the default list.'])
})

test('oneOf: a listed word is kept, and the default is the word of a missing key', () => {
  expect(run({ mode: 'text' })).toEqual({ value: expect.objectContaining({ mode: 'text' }), out: [] })
  expect(run({ mode: 'full' }).value.mode).toBe('full')
  expect(run({}).value.mode).toBe('off')
  expect(defaultsOf(S).mode).toBe('off')
})

test('oneOf: a word that is not listed, in any case, falls back to the default and names the choices', () => {
  for (const bad of ['Text', 'yes', '', 7, null, true, ['text'], {}]) {
    const { value, out } = run({ mode: bad })
    expect(value.mode).toBe('off')
    expect(out).toEqual([`mode: ${show(bad)} is not one of off, text, full. Using off.`])
  }
})

test('oneOf: the fallback is the caller default, so the last good value can stand', () => {
  const out: string[] = []
  const value = normaliseWith(S, { mode: 'nope' }, { ...defaultsOf(S), mode: 'text' }, w => void out.push(w))
  expect(value.mode).toBe('text')
  expect(out).toEqual(['mode: "nope" is not one of off, text, full. Using text.'])
})

test('obj: nested values carry the path', () => {
  const { value, out } = run({ o: { t: 99 } })
  expect(value.o.t).toBe(10)
  expect(out).toEqual(['o.t: 99 is above the max 10. Using 10.'])
})

test('obj: a value that is not an object gives the nested defaults', () => {
  for (const bad of [7, null, [], 'x']) {
    const { value, out } = run({ o: bad })
    expect(value.o).toEqual({ t: 3 })
    expect(out).toEqual([`o: ${show(bad)} is not an object. Using the defaults.`])
  }
})

test('unknown keys are kept and named', () => {
  const { value, out } = run({ chunksize: 10 })
  expect((value as Record<string, unknown>).chunksize).toBe(10)
  expect(out).toEqual(['chunksize: unknown key. The mod keeps it and ignores it.'])
  expect(run({ chunksize: 10 }, 'global').out).toEqual([
    'global.chunksize: unknown key. The mod keeps it and ignores it.',
  ])
})

test('unknown keys inside a nested object carry the full path', () => {
  expect(run({ o: { tt: 1 } }, 'global').out).toEqual(['global.o.tt: unknown key. The mod keeps it and ignores it.'])
})

test('the fallback is the defaults argument, not the schema', () => {
  const out: string[] = []
  const value = normaliseWith(S, { n: 'x' }, { ...defaultsOf(S), n: 7 }, w => void out.push(w))
  expect(value.n).toBe(7)
  expect(out).toEqual(['n: "x" is not a number. Using 7.'])
})

test('a raw value that is not an object reads as an empty one', () => {
  expect(run(undefined).value).toEqual(defaultsOf(S))
  expect(run([1]).out).toEqual([])
})

test('defaultsOf copies the word list so a caller cannot change the schema', () => {
  const d = defaultsOf(S)
  expect(d.w).toEqual(['issue', 'bug'])
  expect(d.w).not.toBe(S.w.def)
})

test('show cuts at 40 characters', () => {
  const cut = show('x'.repeat(60))
  expect(cut.length).toBe(41)
  expect(cut.endsWith('…')).toBe(true)
  expect(show('abc')).toBe('"abc"')
  expect(show(undefined)).toBe('undefined')
  expect(show(10n)).toBe('10')
})

test('specOf: defaults are frozen and normalise is normaliseWith', () => {
  const spec = specOf(S)
  expect(Object.isFrozen(spec.defaults)).toBe(true)
  expect(Object.isFrozen(spec.defaults.o)).toBe(true)
  expect(Object.isFrozen(spec.defaults.w)).toBe(true)
  const out: string[] = []
  expect(spec.normalise({ n: 0 }, spec.defaults, w => void out.push(w)).n).toBe(1)
  expect(out).toEqual(['n: 0 is below the min 1. Using 1.'])
})

test('deepFreeze freezes nested objects and arrays', () => {
  const v = deepFreeze({ a: { b: [1, { c: 2 }] }, d: 'x' })
  expect(Object.isFrozen(v)).toBe(true)
  expect(Object.isFrozen(v.a)).toBe(true)
  expect(Object.isFrozen(v.a.b)).toBe(true)
  expect(Object.isFrozen(v.a.b[1])).toBe(true)
  expect(deepFreeze(5)).toBe(5)
  expect(deepFreeze(null)).toBe(null)
})

test('a key that only Object.prototype has is an unknown key', () => {
  expect(run({ constructor: 1 }).out).toEqual(['constructor: unknown key. The mod keeps it and ignores it.'])
})

test('movedKeys: a key that moved gets one problem naming its new path, and the mod keeps it', () => {
  const spec = movedKeys(specOf(S), { old: 'trackers.other.old' })
  const out: string[] = []
  const value = spec.normalise({ n: 60, old: 5, extra: 1 }, spec.defaults, w => void out.push(w))
  expect(value).toMatchObject({ n: 60, old: 5, extra: 1 })
  expect(out).toEqual([
    'extra: unknown key. The mod keeps it and ignores it.',
    'old: moved to trackers.other.old. The mod keeps it and ignores it here.',
  ])
  const quiet: string[] = []
  expect(spec.normalise({ n: 7 }, spec.defaults, w => void quiet.push(w))).toEqual({ ...spec.defaults, n: 7 })
  expect(quiet).toEqual([]) // a file that does not set the old key hears nothing
  expect(spec.defaults).toEqual(specOf(S).defaults)
})

test('movedKeys: an own __proto__ key is data, so it is an unknown key and the mod keeps it', () => {
  const spec = movedKeys(specOf(S), { old: 'trackers.other.old' })
  const raw = JSON.parse('{"__proto__":{"polluted":true},"n":60,"old":5}') as Record<string, never>
  const out: string[] = []
  const value = spec.normalise(raw, spec.defaults, w => void out.push(w))
  expect(out).toEqual([
    '__proto__: unknown key. The mod keeps it and ignores it.',
    'old: moved to trackers.other.old. The mod keeps it and ignores it here.',
  ])
  expect(Object.hasOwn(value, '__proto__')).toBe(true)
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect((value as { n: number }).n).toBe(60)
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
})

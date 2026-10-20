// The reason algebra of issue #62: the precedence, the merge of two sightings, the source-to-reason rule and the check of
// the reasons a kind adds. Pure.
import { expect, test } from 'claude-code/testing'
import type { CoreReason, KindReason } from '../core/interfaces/reasons'
import {
  addReason,
  checkKindReasons,
  dropReason,
  isCoreReason,
  isReasonSet,
  joinReasons,
  keepKindReasons,
  kindReason,
  REASON_ORDER,
  reasonOfSource,
  reasonSet,
} from '../core/lib/reasons'

const CORE: readonly CoreReason[] = ['created', 'updated', 'read', 'deleted', 'published', 'discovered', 'mentioned']

test('core reasons: the seven words of the issue, and nothing else, are core reasons', () => {
  expect(CORE.every(isCoreReason)).toBe(true)
  expect([...REASON_ORDER].sort()).toEqual([...CORE].sort())
  expect(['reviewed', '', 'READ', 3, null, undefined].some(isCoreReason)).toBe(false)
})

test('precedence: deleted > created > updated > published > read > discovered > mentioned', () => {
  expect(REASON_ORDER).toEqual(['deleted', 'created', 'updated', 'published', 'read', 'discovered', 'mentioned'])
  const set = CORE.reduce((s, r) => addReason(s, r), reasonSet('mentioned'))
  expect(set.strongest).toBe('deleted')
  expect(set.all).toEqual(REASON_ORDER)
  // Each word beats every word after it.
  for (let i = 0; i < REASON_ORDER.length - 1; i++) {
    const pair = addReason(reasonSet(REASON_ORDER[i + 1]!), REASON_ORDER[i]!)
    expect(pair.strongest).toBe(REASON_ORDER[i]!)
  }
})

test('reasonSet: one reason is first, all and strongest; a second reason joins `all` and keeps `first`', () => {
  const one = reasonSet('mentioned')
  expect(one).toEqual({ first: 'mentioned', all: ['mentioned'], strongest: 'mentioned' })
  const two = addReason(one, 'created')
  expect(two).toEqual({ first: 'mentioned', all: ['created', 'mentioned'], strongest: 'created' })
  // A reason already there changes nothing: the same object comes back.
  expect(addReason(two, 'mentioned')).toBe(two)
  expect(addReason(two, 'created')).toBe(two)
})

test('merge: the order of the claims changes neither `all` nor `strongest`', () => {
  const seen: CoreReason[] = ['read', 'mentioned', 'updated', 'read', 'discovered']
  const forward = seen.slice(1).reduce((s, r) => addReason(s, r), reasonSet(seen[0]!))
  const backward = [...seen]
    .reverse()
    .slice(1)
    .reduce((s, r) => addReason(s, r), reasonSet(seen[seen.length - 1]!))
  expect(forward.all).toEqual(backward.all)
  expect(forward.strongest).toBe(backward.strongest)
  expect(forward.all).toEqual(['updated', 'read', 'discovered', 'mentioned'])
  expect(forward.strongest).toBe('updated')
  // Every one of the 120 orders of five distinct reasons gives one set.
  const five: CoreReason[] = ['created', 'read', 'published', 'discovered', 'mentioned']
  const perms = (xs: CoreReason[]): CoreReason[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))
  const sets = perms(five).map(p => p.slice(1).reduce((s, r) => addReason(s, r), reasonSet(p[0]!)))
  expect(new Set(sets.map(s => `${s.all.join()}|${s.strongest}`)).size).toBe(1)
  // `first` is the reason of the earliest sighting, so it follows the order. That is its meaning.
  expect(new Set(sets.map(s => s.first)).size).toBe(five.length)
})

test('join: two records of one item union their reasons and keep the `first` of the older one, whatever the order', () => {
  const older = reasonSet('read')
  const newer = addReason(reasonSet('mentioned'), 'updated')
  const a = joinReasons(older, newer, 'a')
  const b = joinReasons(newer, older, 'b')
  expect(a).toEqual(b)
  expect(a).toEqual({ first: 'read', all: ['updated', 'read', 'mentioned'], strongest: 'updated' })
  expect(joinReasons(older, older, 'a')).toBe(older)
})

test('drop: a reason leaves; `first` falls to the strongest left when it was the dropped one; none left gives undefined', () => {
  const set = addReason(addReason(reasonSet('discovered'), 'mentioned'), 'read')
  expect(dropReason(set, 'discovered')).toEqual({ first: 'read', all: ['read', 'mentioned'], strongest: 'read' })
  expect(dropReason(set, 'mentioned')).toEqual({ first: 'discovered', all: ['read', 'discovered'], strongest: 'read' })
  expect(dropReason(set, 'created')).toBe(set)
  expect(dropReason(reasonSet('discovered'), 'discovered')).toBeUndefined()
})

test('isReasonSet: a stored value counts only when every word is a core reason and `first` and `strongest` are in `all`', () => {
  expect(isReasonSet(reasonSet('read'))).toBe(true)
  expect(isReasonSet(addReason(reasonSet('read'), 'created'))).toBe(true)
  for (const bad of [
    undefined,
    null,
    'read',
    {},
    { first: 'read', all: [], strongest: 'read' },
    { first: 'read', all: ['read'], strongest: 'created' },
    { first: 'created', all: ['read'], strongest: 'read' },
    { first: 'read', all: ['read', 'bogus'], strongest: 'read' },
    { first: 'read', all: 'read', strongest: 'read' },
    { first: 'read', all: ['mentioned', 'read'], strongest: 'read' }, // not strongest first
  ])
    expect(isReasonSet(bad)).toBe(false)
})

test('reasonOfSource: a tool sighting reads, the PR lane discovers, any text mentions; an odd source never throws', () => {
  expect(reasonOfSource('tool')).toBe('read')
  expect(reasonOfSource('prompt')).toBe('mentioned')
  expect(reasonOfSource('response')).toBe('mentioned')
  expect(reasonOfSource('auto')).toBe('discovered')
  expect(reasonOfSource('pr-body')).toBe('discovered')
  for (const odd of ['scan', 'prepare', 'load', '', 'x']) expect(reasonOfSource(odd)).toBe('mentioned')
})

test('kind reasons: each maps to one core reason; the claim of a kind takes the core word of its own', () => {
  const declared: KindReason[] = [
    { id: 'reviewed', core: 'read' },
    { id: 'approved', core: 'updated' },
  ]
  expect(keepKindReasons('review', declared)).toEqual({ kept: declared, problems: [] })
  expect(keepKindReasons('review', undefined)).toEqual({ kept: [], problems: [] })
  expect(kindReason(declared, 'reviewed')).toBe('read')
  expect(kindReason(declared, 'approved')).toBe('updated')
  expect(() => kindReason(declared, 'liked')).toThrow(/liked/)
  expect(() => kindReason(undefined, 'reviewed')).toThrow(/reviewed/)
})

test('kind reasons: a word that is off can never make a claim', () => {
  const declared = [
    { id: 'reviewed' }, // unmapped
    { id: 'liked', core: 'seen' }, // not a core reason
    { id: 'read', core: 'created' }, // a core word
    { id: ' ', core: 'read' }, // empty
    { id: 'signed', core: 'updated' },
  ] as unknown as KindReason[]
  for (const off of ['reviewed', 'liked', 'read', ' ']) expect(() => kindReason(declared, off)).toThrow(/core reason/)
  expect(kindReason(declared, 'signed')).toBe('updated')
  // A repeat: the first word stays, as in the check.
  expect(
    kindReason(
      [
        { id: 'seen', core: 'read' },
        { id: 'seen', core: 'created' },
      ],
      'seen',
    ),
  ).toBe('read')
})

test('kind reasons: an unmapped or a duplicate reason is dropped with a problem, like a key that is taken', () => {
  const keep = (list: unknown) => keepKindReasons('review', list as readonly KindReason[])
  const good = { id: 'approved', core: 'updated' } as const
  // Unmapped: no core reason, or a word that is not one. The word is off; the good word beside it stays.
  expect(keep([{ id: 'reviewed' }, good])).toEqual({
    kept: [good],
    problems: ['reasons: kind review reason "reviewed" is not mapped to a core reason. The reason is off.'],
  })
  expect(keep([{ id: 'reviewed', core: 'seen' }, good]).problems).toEqual([
    'reasons: kind review reason "reviewed" is not mapped to a core reason. The reason is off.',
  ])
  // Duplicate: the same word twice. The first stays, the repeat is off, whether it maps the same or not.
  const first = { id: 'reviewed', core: 'read' } as const
  expect(keep([first, { id: 'reviewed', core: 'read' }])).toEqual({
    kept: [first],
    problems: ['reasons: kind review declares reason "reviewed" twice. The reason is off.'],
  })
  expect(keep([first, { id: 'reviewed', core: 'created' }]).kept).toEqual([first])
  // A kind may not give a new meaning to a core word, or use an empty word.
  expect(keep([{ id: 'read', core: 'created' }])).toEqual({
    kept: [],
    problems: ['reasons: kind review reason "read" is already a core reason. The reason is off.'],
  })
  expect(keep([{ id: ' ', core: 'read' }])).toEqual({
    kept: [],
    problems: ['reasons: kind review declares an empty reason. The reason is off.'],
  })
  // Every bad word is reported, and none of them throws.
  expect(keep([{ id: 'a' }, { id: 'b', core: 'x' }, first, first]).problems).toHaveLength(3)
})

test('kind reasons: a word two kinds share must map to one core reason; the later kind loses a clash, not its other words', () => {
  const kind = (category: string, reasons: KindReason[]) => ({ category, reasons })
  const same = checkKindReasons([
    kind('review', [{ id: 'seen', core: 'read' }]),
    kind('audit', [{ id: 'seen', core: 'read' }]),
  ])
  expect(same.problems).toEqual([])
  expect([...same.kept.keys()]).toEqual(['review', 'audit'])
  const clash = checkKindReasons([
    kind('review', [{ id: 'seen', core: 'read' }]),
    kind('audit', [
      { id: 'seen', core: 'updated' },
      { id: 'signed', core: 'updated' },
    ]),
    kind('plain', []),
  ])
  expect(clash.problems).toEqual([
    'reasons: kind audit maps "seen" to updated, but kind review maps it to read. The reason is off.',
  ])
  expect(clash.kept.get('review')).toEqual([{ id: 'seen', core: 'read' }])
  expect(clash.kept.get('audit')).toEqual([{ id: 'signed', core: 'updated' }])
  expect(clash.kept.get('plain')).toEqual([])
  // A kind's own problems come first, then its clashes with the kinds before it.
  const both = checkKindReasons([
    kind('review', [{ id: 'seen', core: 'read' }]),
    { category: 'audit', reasons: [{ id: 'seen' }, { id: 'seen', core: 'updated' }] as unknown as KindReason[] },
  ])
  expect(both.problems).toEqual([
    'reasons: kind audit reason "seen" is not mapped to a core reason. The reason is off.',
    'reasons: kind audit maps "seen" to updated, but kind review maps it to read. The reason is off.',
  ])
})

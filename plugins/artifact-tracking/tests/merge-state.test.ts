// The merge state of a PR (issue #50): the chip a row shows, the notes the PR lane keeps for the rows, and the retry
// schedule for a PR that GitHub still calls UNKNOWN. Pure: no `$`, no clock but the one a test passes.
import { expect, test } from 'claude-code/testing'
import {
  conflictCount,
  isFresh,
  mergeChip,
  mergeNotes,
  QUEUED_MS,
  RETRY_MS,
  retryDelay,
  UNKNOWN_SPENT,
} from '../trackers/github/merge'
import type { GitHubRecord, MergeNote } from '../trackers/github/types'
import type { ToolStatus } from '../types'
import { LANE } from './fixtures/reasons'

const NOW = 5_000_000
const K7 = 'gh:github.com/acme/web#7'

const pr = (over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: K7,
  category: 'github',
  url: 'https://github.com/acme/web/pull/7',
  label: 'acme/web#7',
  ...LANE,
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 0,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: 7,
  type: 'pr',
  state: 'open',
  headRefName: 'feat/a',
  baseRefName: 'main',
  ...over,
})

const env = (notes: Record<string, MergeNote> = {}, over: Partial<{ fresh: boolean; now: number }> = {}) => ({
  fresh: true,
  now: NOW,
  notes,
  ...over,
})

const chip = (over: Partial<GitHubRecord>, e = env()) => mergeChip(pr(over), e)

// ---------------------------------------------------------------- the chip

test('AC1: an open PR that GitHub calls CONFLICTING gets the red ✗ conflicts chip', () => {
  expect(chip({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toEqual({ text: '✗ conflicts', tone: 'bad' })
})

test('AC2: MERGEABLE and BEHIND is the yellow ↓ behind chip; MERGEABLE and anything else is no chip', () => {
  expect(chip({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })).toEqual({ text: '↓ behind', tone: 'warn' })
  for (const mergeStateStatus of ['CLEAN', 'UNSTABLE', 'BLOCKED', 'HAS_HOOKS', 'DRAFT', undefined])
    expect(chip({ mergeable: 'MERGEABLE', ...(mergeStateStatus ? { mergeStateStatus } : {}) })).toBeNull()
})

test('AC3: a stacked PR (a base other than the default branch) gets the same chip: the chip never reads the base', () => {
  expect(chip({ mergeable: 'CONFLICTING', baseRefName: 'fix/stack-base' })).toEqual({
    text: '✗ conflicts',
    tone: 'bad',
  })
})

test('AC6: a draft PR that is CONFLICTING shows the chip although its mergeStateStatus reads DRAFT', () => {
  expect(chip({ isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DRAFT' })).toEqual({
    text: '✗ conflicts',
    tone: 'bad',
  })
})

test('AC4: UNKNOWN gives no chip while a re-poll is pending, and ? merge once the retries are spent', () => {
  expect(chip({ mergeable: 'UNKNOWN' })).toBeNull() // no note: no step has looked yet
  for (let unknown = 1; unknown < UNKNOWN_SPENT; unknown++)
    expect(chip({ mergeable: 'UNKNOWN' }, env({ [K7]: { unknown } }))).toBeNull()
  expect(chip({ mergeable: 'UNKNOWN' }, env({ [K7]: { unknown: UNKNOWN_SPENT } }))).toEqual({
    text: '? merge',
    tone: 'dim',
  })
})

test('a merged or closed PR, an issue and a record with no merge value have no chip', () => {
  expect(chip({ state: 'merged', mergeable: 'CONFLICTING' })).toBeNull()
  expect(chip({ state: 'closed', mergeable: 'CONFLICTING' })).toBeNull()
  expect(chip({ type: 'issue', mergeable: 'CONFLICTING' })).toBeNull()
  expect(chip({})).toBeNull()
  expect(mergeChip(pr({ mergeable: 'CONFLICTING' }), undefined)).toBeNull() // a caller with no lane state
})

test('AC11: with gh logged out or its breaker open, no chip shows: the value is stale, not current', () => {
  expect(chip({ mergeable: 'CONFLICTING' }, env({}, { fresh: false }))).toBeNull()
  expect(chip({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }, env({}, { fresh: false }))).toBeNull()
  expect(chip({ mergeable: 'UNKNOWN' }, env({ [K7]: { unknown: UNKNOWN_SPENT } }, { fresh: false }))).toBeNull()
})

test('isFresh: only a gh that is logged out, missing or has an open breaker makes a value stale', () => {
  const gh = (over: Partial<ToolStatus>): ToolStatus => ({
    name: 'gh',
    available: true,
    loggedIn: true,
    breaker: 'closed',
    ...over,
  })
  expect(isFresh(gh({}))).toBe(true)
  expect(isFresh(gh({ available: null, loggedIn: null }))).toBe(true) // not asked yet: the stored value stands
  expect(isFresh(gh({ breaker: 'half-open' }))).toBe(true)
  expect(isFresh(gh({ loggedIn: false }))).toBe(false)
  expect(isFresh(gh({ available: false }))).toBe(false)
  expect(isFresh(gh({ breaker: 'open' }))).toBe(false)
  expect(isFresh(undefined)).toBe(true) // no status in the atom: nothing says it is stale
})

test('AC8: a PR whose resolve prompt was sent reads queued for ten minutes, then the chip comes back', () => {
  const notes = { [K7]: { queuedAt: NOW - 1000 } }
  expect(chip({ mergeable: 'CONFLICTING' }, env(notes))).toEqual({ text: 'queued', tone: 'warn' })
  const old = { [K7]: { queuedAt: NOW - QUEUED_MS } }
  expect(chip({ mergeable: 'CONFLICTING' }, env(old))).toEqual({ text: '✗ conflicts', tone: 'bad' })
})

test('conflictCount: the open PRs that GitHub calls CONFLICTING, none while the value is stale', () => {
  const list = [
    pr({ number: 1, mergeable: 'CONFLICTING' }),
    pr({ number: 2, mergeable: 'CONFLICTING', isDraft: true, mergeStateStatus: 'DRAFT' }),
    pr({ number: 3, mergeable: 'MERGEABLE' }),
    pr({ number: 4, mergeable: 'CONFLICTING', state: 'closed' }),
  ]
  expect(conflictCount(list, env())).toBe(2)
  expect(conflictCount(list, env({}, { fresh: false }))).toBe(0)
  expect(conflictCount(list, undefined)).toBe(0)
})

// ---------------------------------------------------------------- the notes

test('mergeNotes: a CONFLICTING PR keeps its worktree; a clean one and one with no value keep no note', () => {
  const next = mergeNotes(undefined, [
    { key: 'a', mergeable: 'CONFLICTING', worktree: '/w/a' },
    { key: 'b', mergeable: 'CONFLICTING' },
    { key: 'c', mergeable: 'MERGEABLE' },
    { key: 'd', mergeable: undefined },
  ])
  expect(next).toEqual({ a: { worktree: '/w/a' }, b: {} })
})

test('mergeNotes: the person’s press and the files stay while the PR stays CONFLICTING, and go when it changes', () => {
  const files = { at: 9, files: ['x.ts'] }
  const prev = { a: { worktree: '/w/a', queuedAt: 7, files }, b: { queuedAt: 7, files } }
  const still = mergeNotes(prev, [
    { key: 'a', mergeable: 'CONFLICTING', worktree: '/w/other' },
    { key: 'b', mergeable: 'UNKNOWN' }, // a push: GitHub works it out again
  ])
  expect(still).toEqual({ a: { worktree: '/w/other', queuedAt: 7, files }, b: { unknown: 1 } })
  expect(mergeNotes(prev, [{ key: 'a', mergeable: 'MERGEABLE' }])).toBeUndefined() // resolved: nothing left to say
})

test('mergeNotes: UNKNOWN counts the steps that saw it, up to UNKNOWN_SPENT; a known value starts the count again', () => {
  let notes: Record<string, MergeNote> | undefined
  const seen = [{ key: 'a', mergeable: 'UNKNOWN' as const }]
  for (let i = 1; i <= UNKNOWN_SPENT + 3; i++) {
    notes = mergeNotes(notes, seen)
    expect(notes?.a?.unknown).toBe(Math.min(i, UNKNOWN_SPENT))
  }
  const known = mergeNotes(notes, [{ key: 'a', mergeable: 'MERGEABLE' as const }])
  expect(known).toBeUndefined()
  expect(mergeNotes(known, seen)?.a?.unknown).toBe(1)
})

test('mergeNotes: a quiet step gives back the input object (A22), a PR that left the reply loses its note', () => {
  const first = mergeNotes(undefined, [{ key: 'a', mergeable: 'CONFLICTING', worktree: '/w/a' }])
  expect(mergeNotes(first, [{ key: 'a', mergeable: 'CONFLICTING', worktree: '/w/a' }])).toBe(first)
  const spent = mergeNotes({ a: { unknown: UNKNOWN_SPENT } }, [{ key: 'a', mergeable: 'UNKNOWN' }])
  expect(spent).toEqual({ a: { unknown: UNKNOWN_SPENT } })
  expect(mergeNotes(first, [])).toBeUndefined()
  expect(mergeNotes(undefined, [])).toBeUndefined()
})

test('mergeNotes: after an incomplete reply the notes of the PRs it left out stay, so a press is not forgotten', () => {
  const prev = { a: { worktree: '/w/a', queuedAt: 7 }, b: { unknown: 2 } }
  const seen = [{ key: 'b', mergeable: 'UNKNOWN' as const }]
  expect(mergeNotes(prev, seen, { keepMissing: true })).toEqual({ a: prev.a, b: { unknown: 3 } })
  expect(mergeNotes(prev, seen)).toEqual({ b: { unknown: 3 } }) // a complete reply: a PR that left has no note
  // Not named in this reply: the note of a CONFLICTING PR stays as it is. An UNKNOWN note counts the look (see below).
  expect(mergeNotes(prev, [{ key: 'a', mergeable: 'MERGEABLE' as const }], { keepMissing: true })).toEqual({
    b: { unknown: 3 },
  })
})

test('mergeNotes: in a complete reply the notes of the held keys stay, and the others go (issue #158)', () => {
  const prev = { a: { worktree: '/w/a' }, b: { unknown: 2 }, c: {} }
  const held = new Set(['b', 'c'])
  // `b` and `c` are PRs of a repo that gave no answer: the reply does not name them, and their notes stay. An UNKNOWN note
  // counts the look as a PR in the reply would. `a` left a complete reply: no note.
  expect(mergeNotes(prev, [], { keep: held })).toEqual({ b: { unknown: 3 }, c: {} })
  expect(mergeNotes(prev, [{ key: 'b', mergeable: 'MERGEABLE' as const }], { keep: held })).toEqual({ c: {} })
  expect(mergeNotes(prev, [], { keep: new Set() })).toBeUndefined()
  expect(mergeNotes({ c: {} }, [], { keep: new Set(['c']) })).toEqual({ c: {} })
})

test('AC4: a kept UNKNOWN note counts every step that asked, so a PR that stays out of the replies runs out of retries', () => {
  let notes = mergeNotes(undefined, [{ key: 'a', mergeable: 'UNKNOWN' }])
  expect(retryDelay(notes)).toBe(RETRY_MS[0])
  const counts: Array<number | undefined> = []
  const delays: Array<number | undefined> = []
  for (let i = 0; i < 5; i++) {
    notes = mergeNotes(notes, [], { keepMissing: true }) // an incomplete reply that leaves #a out
    counts.push(notes?.a?.unknown)
    delays.push(retryDelay(notes))
  }
  expect(counts).toEqual([2, 3, 4, 4, 4])
  expect(delays).toEqual([RETRY_MS[1], RETRY_MS[2], undefined, undefined, undefined])
})

test('mergeNotes: a kept CONFLICTING note is not changed by the steps that leave its PR out (A22)', () => {
  const prev = { a: { worktree: '/w/a', queuedAt: 7, files: { at: 1, files: ['x.ts'] } } }
  expect(mergeNotes(prev, [], { keepMissing: true })).toBe(prev)
})

// ---------------------------------------------------------------- the retries

test('AC4: the retries come after 3 s, 6 s and 12 s, and then stop', () => {
  expect(RETRY_MS).toEqual([3000, 6000, 12000])
  expect(UNKNOWN_SPENT).toBe(4)
  expect([1, 2, 3].map(unknown => retryDelay({ a: { unknown } }))).toEqual([3000, 6000, 12000])
  expect(retryDelay({ a: { unknown: UNKNOWN_SPENT } })).toBeUndefined()
})

test('retryDelay: the PR that was asked least decides; PRs that are not UNKNOWN do not count', () => {
  expect(retryDelay({ a: { unknown: 3 }, b: { unknown: 1 }, c: { worktree: '/w' }, d: { unknown: 4 } })).toBe(3000)
  expect(retryDelay({ c: { worktree: '/w' }, d: { unknown: 4 } })).toBeUndefined()
  expect(retryDelay({})).toBeUndefined()
  expect(retryDelay(undefined)).toBeUndefined()
})

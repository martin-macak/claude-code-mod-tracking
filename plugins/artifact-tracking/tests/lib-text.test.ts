// The text helpers of core/lib/text.ts: ages, the note of a tool, compact ids, first line. Cases moved from the legacy
// view tests (plan L6, Task 13). Pure.
import { expect, test } from 'claude-code/testing'
import { ago, clip, compactIds, firstLine, message, toolNote } from '../core/lib/text'
import type { ToolStatus } from './fixtures/contracts'

const NOW = 1_000_000

const gh = (over: Partial<ToolStatus> = {}): ToolStatus => ({
  name: 'gh',
  available: true,
  loggedIn: true,
  breaker: 'closed',
  ...over,
})

test('ago steps', () => {
  expect(ago(0)).toBe('now')
  expect(ago(999)).toBe('now')
  expect(ago(1000)).toBe('1s')
  expect(ago(12_000)).toBe('12s')
  expect(ago(4 * 60_000)).toBe('4m')
  expect(ago(2 * 3_600_000)).toBe('2h')
  expect(ago(3 * 86_400_000)).toBe('3d')
  expect(ago(Number.NaN)).toBe('now')
})

test('toolNote covers every branch in order', () => {
  expect(toolNote(gh({ available: false }), NOW)).toBe('not installed')
  expect(toolNote(gh({ available: null }), NOW)).toBe('checking…')
  expect(toolNote(gh({ loggedIn: false }), NOW)).toBe('not logged in')
  // logged-out beats an open breaker
  expect(toolNote(gh({ loggedIn: false, breaker: 'open', openUntil: NOW + 1000 }), NOW)).toBe('not logged in')
  expect(toolNote(gh({ breaker: 'open', openUntil: NOW + 4 * 60_000 }), NOW, NOW - 5000)).toBe('paused 4m')
  expect(toolNote(gh({ breaker: 'open' }), NOW)).toBe('paused now') // no end time: the pause shows no wait
  expect(toolNote(gh(), NOW, NOW - 12_000)).toBe('refreshed 12s ago')
  expect(toolNote(gh({ breaker: 'half-open' }), NOW, NOW - 2 * 3_600_000)).toBe('refreshed 2h ago')
  expect(toolNote(gh(), NOW)).toBe('ready')
  expect(toolNote(gh({ loggedIn: null }), NOW)).toBe('ready')
  // not installed is checked before logged in
  expect(toolNote(gh({ available: false, loggedIn: false }), NOW)).toBe('not installed')
})

test('toolNote says "just now" for a refresh under a second ago', () => {
  expect(toolNote(gh(), NOW, NOW - 500)).toBe('refreshed just now')
  expect(toolNote(gh(), NOW, NOW + 500)).toBe('refreshed just now') // clock skew
})

test('compactIds: an agent id compacts to 8 hex, in names, branches and worktrees', () => {
  expect(compactIds('agent-a94bdd45b56e2c631')).toBe('agent-a94bdd45')
  expect(compactIds('worktree-agent-a94bdd45b56e2c631')).toBe('worktree-agent-a94bdd45')
  expect(compactIds('agent-a94bdd45')).toBe('agent-a94bdd45')
})

test('compactIds: a workflow run id keeps 6 characters before the last -digits', () => {
  expect(compactIds('wf_a35565d1-fd4-21')).toBe('wf_a35565-21')
  expect(compactIds('wf_abc-1')).toBe('wf_abc-1')
})

test('compactIds leaves a long hex string that is not an agent id alone', () => {
  expect(compactIds('fix/deadbeefcafe1234')).toBe('fix/deadbeefcafe1234')
  expect(compactIds('abc1234567890abcdef')).toBe('abc1234567890abcdef')
  expect(compactIds('agent-a94bdd4')).toBe('agent-a94bdd4')
})

test('firstLine and message', () => {
  expect(firstLine('  one\ntwo')).toBe('one')
  expect(firstLine('')).toBe('')
  expect(message(new Error('boom'))).toBe('boom')
  expect(message('plain')).toBe('plain')
})

test('clip: cut to the cap in code units, and a surrogate pair is never split', () => {
  expect(clip('abcdef', 3)).toBe('abc')
  expect(clip('abc', 10)).toBe('abc')
  expect(clip('abc', 0)).toBe('')
  expect(clip('abc', -4)).toBe('')
  expect(clip('a😀b', 2)).toBe('a') // the cut falls inside the pair: it goes whole, or not at all
  expect(clip('a😀b', 3)).toBe('a😀')
  expect(clip('', 5)).toBe('')
})

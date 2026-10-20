// Dismiss list: ids of the current auto rows and items. Pure.
import { expect, test } from 'claude-code/testing'
import { addReason } from '../core/lib/reasons'
import { autoIds, dismiss } from '../trackers/auto/dismiss'
import { emptyAuto, pinRoot } from '../trackers/auto/ledger'
import type { AgentRow, AutoSnapshot, AutoState, ItemRecord, WorktreeRow } from './fixtures/contracts'
import { LIMITS } from './fixtures/limits'
import { DISCOVERED, MENTIONED, reasonsOfSources } from './fixtures/reasons'

const wt = (path: string, depth: 0 | 1): WorktreeRow => ({
  id: `wt:${path}`,
  path,
  name: path.split('/').pop() ?? path,
  detached: false,
  state: 'live',
  depth,
})
const ag = (id: string, depth: number, kind: AgentRow['kind'] = 'subagent'): AgentRow => ({
  id: id === 'master' ? 'ag:master' : `ag:${id}`,
  kind,
  label: id,
  depth,
  worktreeLive: false,
  state: 'running',
})

const snapshot = (over: Partial<AutoSnapshot> = {}): AutoSnapshot => ({
  at: 1,
  worktrees: [wt('/r', 0), wt('/r/.claude/worktrees/a', 1), wt('/r/.claude/worktrees/b', 1)],
  agents: [ag('master', 0, 'master'), ag('p', 1), ag('c', 2), ag('q', 1)],
  branches: [],
  overflow: 0,
  git: { ok: true, at: 1 },
  agentList: { ok: true, at: 1 },
  prs: { ok: true },
  ...over,
})

const state = (): AutoState => ({ ...pinRoot(emptyAuto(), '/r', 1), snapshot: snapshot() })

const item = (key: string, sources: ItemRecord['sources'], reasons = reasonsOfSources(sources)): ItemRecord => ({
  key,
  category: 'web',
  url: key,
  label: key,
  sources,
  reasons,
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 0,
})

test('autoIds lists children, agents and auto items; never the root or the master', () => {
  const ids = autoIds(state(), [
    item('web:a', [], DISCOVERED),
    item('web:b', [], DISCOVERED),
    item('web:c', ['prompt']),
    item('web:d', ['prompt'], addReason(MENTIONED, 'discovered')),
  ])
  expect(ids).toEqual([
    'wt:/r/.claude/worktrees/a',
    'wt:/r/.claude/worktrees/b',
    'ag:p',
    'ag:c',
    'ag:q',
    'web:a',
    'web:b',
    'web:d', // named in the conversation and found by discovery: still an auto item
  ])
})

test('autoIds on a state with no snapshot lists the items only', () => {
  expect(autoIds(emptyAuto(), [item('web:a', [], DISCOVERED)])).toEqual(['web:a'])
})

test('dismiss adds the ids and drops their rows from the snapshot', () => {
  const s = dismiss(state(), ['wt:/r/.claude/worktrees/a', 'ag:q'])
  expect(s.dismissed).toEqual(['wt:/r/.claude/worktrees/a', 'ag:q'])
  expect(s.snapshot?.worktrees.map(r => r.id)).toEqual(['wt:/r', 'wt:/r/.claude/worktrees/b'])
  expect(s.snapshot?.agents.map(r => r.id)).toEqual(['ag:master', 'ag:p', 'ag:c'])
})

test('dismiss of an agent drops its whole subtree rows', () => {
  const s = dismiss(state(), ['ag:p'])
  expect(s.snapshot?.agents.map(r => r.id)).toEqual(['ag:master', 'ag:q'])
})

test('dismiss of known ids returns the same object and keeps the id in the list', () => {
  const s = dismiss(state(), ['ag:q'])
  expect(dismiss(s, ['ag:q'])).toBe(s)
  expect(s.dismissed).toContain('ag:q')
  expect(s.dismissed).not.toContain('ag:p')
})

test('dismiss keeps the newest maxDismissed ids', () => {
  const ids = Array.from({ length: LIMITS.maxDismissed + 20 }, (_, i) => `web:${i}`)
  const s = dismiss(emptyAuto(), ids)
  expect(s.dismissed).toHaveLength(LIMITS.maxDismissed)
  expect(s.dismissed[LIMITS.maxDismissed - 1]).toBe(`web:${LIMITS.maxDismissed + 19}`)
})

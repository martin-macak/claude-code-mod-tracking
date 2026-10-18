// Priority levels: order, markers and the merge of two manual marks (issue #30). Pure.
import { expect, test } from 'claude-code/testing'
import type { GitHubRecord, ItemRecord, JiraNode, WebRecord } from '../hooks/contracts'
import {
  byLevel,
  effectiveLevels,
  type LevelContext,
  markerOf,
  mergeNodePriorities,
  mergePriority,
  RULES,
  rankOf,
} from '../hooks/model/priority'

const node = (key: string, priority?: 'high' | 'normal' | 'low', children: JiraNode[] = []): JiraNode => ({
  key,
  ...(priority ? { priority } : {}),
  summary: key,
  issueType: 'Task',
  status: 'To Do',
  children,
})

test('levels rank top, high, normal, low; no level reads as normal', () => {
  expect(['low', 'top', undefined, 'high', 'normal'].map(l => rankOf(l as never))).toEqual([3, 0, 2, 1, 2])
  expect(byLevel('high', undefined)).toBeLessThan(0)
  expect(byLevel(undefined, 'normal')).toBe(0)
  expect(byLevel('low', 'normal')).toBeGreaterThan(0)
})

test('markers: star for top, up for high, down for low, none for normal or no level', () => {
  expect(['top', 'high', 'normal', 'low', undefined].map(l => markerOf(l as never))).toEqual(['★', '▲', '', '▽', ''])
})

test('mergePriority: a set mark beats no mark; of two set marks the higher wins', () => {
  expect(mergePriority(undefined, undefined)).toBeUndefined()
  expect(mergePriority('low', undefined)).toBe('low')
  expect(mergePriority(undefined, 'low')).toBe('low')
  expect(mergePriority('low', 'normal')).toBe('normal')
  expect(mergePriority('high', 'low')).toBe('high')
  expect(mergePriority('normal', 'high')).toBe('high')
})

test('mergeNodePriorities: each node keeps the merged mark of the same key in the other tree, level by level', () => {
  const a = [node('A-1', undefined, [node('A-2'), node('A-5', 'low')]), node('A-3', 'low')]
  const b = [node('A-1', 'high', [node('A-2', 'low')]), node('A-4', 'high')]
  const out = mergeNodePriorities(a, b)
  expect(out.map(n => [n.key, n.priority])).toEqual([
    ['A-1', 'high'],
    ['A-3', 'low'],
  ])
  expect(out[0]?.children.map(n => [n.key, n.priority])).toEqual([
    ['A-2', 'low'],
    ['A-5', 'low'],
  ])
  expect('priority' in (mergeNodePriorities([node('A-9')], [node('A-9')])[0] ?? {})).toBe(false)
  expect(a[0]?.priority).toBeUndefined() // no input is changed
})

// ---------------------------------------------------------------- auto levels (R7, R8, R9)

const gh = (n: number, type: 'pr' | 'issue' | 'unknown', over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: `gh:github.com/acme/web#${n}`,
  category: 'github',
  url: `https://github.com/acme/web/pull/${n}`,
  label: `acme/web#${n}`,
  sources: ['prompt'],
  firstSeen: n,
  lastSeen: n,
  seenCount: 1,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type,
  ...(type === 'pr' ? { state: 'open' as const, headRefName: 'feat/x' } : {}),
  ...over,
})
const web: WebRecord = {
  key: 'web:https://x.example/',
  category: 'web',
  url: 'https://x.example/',
  label: 'x',
  sources: ['prompt'],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
}
const CTX: LevelContext = { sessionRepo: { host: 'github.com', owner: 'acme', repo: 'web' }, currentBranch: 'feat/x' }
const levels = (items: ItemRecord[], ctx: LevelContext = CTX) =>
  Object.fromEntries(
    [...effectiveLevels(items, ctx)].map(([k, v]) => [k.replace(/.*#/, '#').replace(/^web:.*/, 'web'), v]),
  )

test('R7: an open PR of the session repo on the current branch is top, from a rule', () => {
  expect(levels([gh(1, 'pr')])).toEqual({ '#1': { level: 'top', auto: true } })
})

test('R7: no top for a merged or closed PR, another branch, another repo, no branch or no repo', () => {
  const none = { '#1': {} }
  expect(levels([gh(1, 'pr', { state: 'merged' })])).toEqual(none)
  expect(levels([gh(1, 'pr', { state: 'closed' })])).toEqual(none)
  expect(levels([gh(1, 'pr', { headRefName: 'main' })])).toEqual(none)
  expect(levels([gh(1, 'pr', { owner: 'fork' })])).toEqual(none)
  expect(levels([gh(1, 'pr', { headRefName: undefined })])).toEqual(none)
  expect(levels([gh(1, 'pr')], { sessionRepo: CTX.sessionRepo })).toEqual(none) // detached HEAD: no branch
  expect(levels([gh(1, 'pr')], { currentBranch: 'feat/x', sessionRepo: null })).toEqual(none)
})

test('R7: every open PR on the current branch is top; the repo match ignores case', () => {
  const out = levels([gh(1, 'pr'), gh(2, 'pr', { owner: 'ACME', isDraft: true })])
  expect(out).toEqual({ '#1': { level: 'top', auto: true }, '#2': { level: 'top', auto: true } })
})

test('a manual mark wins over the rule: a person can push a top PR down', () => {
  expect(levels([gh(1, 'pr', { priority: 'low' })])).toEqual({ '#1': { level: 'low' } })
  expect(levels([gh(1, 'pr', { priority: 'normal' })])).toEqual({ '#1': { level: 'normal' } })
})

test('R8: an issue a tracked PR closes takes the PR level, a manual one too', () => {
  const issue = gh(9, 'issue')
  expect(levels([gh(1, 'pr', { closes: [issue.key] }), issue])['#9']).toEqual({ level: 'top', auto: true })
  const marked = gh(2, 'pr', { headRefName: 'other', priority: 'high', closes: [issue.key] })
  expect(levels([marked, issue])['#9']).toEqual({ level: 'high', auto: true })
})

test('R8: of several closing PRs the highest level wins, low included when it is the only one', () => {
  const issue = gh(9, 'issue')
  const high = gh(2, 'pr', { headRefName: 'b', priority: 'high', closes: [issue.key] })
  const low = gh(3, 'pr', { headRefName: 'c', priority: 'low', closes: [issue.key] })
  expect(levels([low, issue, high])['#9']).toEqual({ level: 'high', auto: true })
  expect(levels([low, issue])['#9']).toEqual({ level: 'low', auto: true })
  const plain = gh(4, 'pr', { headRefName: 'd', closes: [issue.key] })
  expect(levels([low, plain, issue])['#9']).toEqual({})
})

test("R8: the issue's own mark wins; an issue no tracked PR closes has no auto level", () => {
  const issue = gh(9, 'issue', { priority: 'low' })
  expect(levels([gh(1, 'pr', { closes: [issue.key] }), issue])['#9']).toEqual({ level: 'low' })
  expect(levels([gh(9, 'issue')])['#9']).toEqual({})
})

test('R9: Jira, web and a GitHub item of unknown type have no rule; a rule table can be passed in', () => {
  expect(levels([web, gh(5, 'unknown', { state: 'open', headRefName: 'feat/x' })])).toEqual({ web: {}, '#5': {} })
  expect(Object.keys(RULES).sort()).toEqual(['github-issue', 'github-pr'])
  const custom = effectiveLevels([web], CTX, [{ id: 'web', stage: 0, level: () => 'high' }])
  expect(custom.get(web.key)).toEqual({ level: 'high', auto: true })
})

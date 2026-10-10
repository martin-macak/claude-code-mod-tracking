// Porcelain parser, locate and the agent convention path. Pure.
import { expect, test } from 'claude-code/testing'
import { agentWorktreePath, findByPath, locate, normPath, parsePorcelain } from '../hooks/auto/porcelain'
import type { GitWorktree } from '../hooks/contracts'
import { PORCELAIN_SAMPLE, PORCELAIN_SESSION } from './fixtures/git'

test('parsePorcelain reads branch, detached, prunable, locked and bare records', () => {
  const list = parsePorcelain(PORCELAIN_SAMPLE)
  expect(list).toHaveLength(5)
  expect(list[0]).toEqual({
    path: '/x/repo',
    head: 'b8168631aad3bc31d4f728ade0e9d72b2a5e9d89',
    branch: 'feat/parent',
    detached: false,
    bare: false,
  })
  expect(list[1]?.prunable).toBe('gitdir file points to non-existent location')
  expect(list[2]?.locked).toBe('claude agent running')
  expect(list[3]?.detached).toBe(true)
  expect(list[3]?.branch).toBeUndefined()
  expect(list[4]?.bare).toBe(true)
})

test('parsePorcelain: empty input, trailing blank lines and a lock with no reason', () => {
  expect(parsePorcelain('')).toEqual([])
  expect(parsePorcelain('\n\n')).toEqual([])
  const list = parsePorcelain('worktree /a\nHEAD abc\nbranch refs/heads/x\nlocked\n\n\n')
  expect(list).toHaveLength(1)
  expect(list[0]?.locked).toBe('')
})

test('parsePorcelain keeps a path with spaces', () => {
  const list = parsePorcelain('worktree /a b/c d\nHEAD abc\nbranch refs/heads/x\n')
  expect(list[0]?.path).toBe('/a b/c d')
})

test('parsePorcelain gives the same result for CRLF line endings', () => {
  const crlf = PORCELAIN_SESSION.replace(/\n/g, '\r\n')
  expect(parsePorcelain(crlf)).toEqual(parsePorcelain(PORCELAIN_SESSION))
})

test('locate: exact path, a subfolder, the longest prefix wins, no match', () => {
  const list = parsePorcelain(PORCELAIN_SESSION)
  expect(locate(list, '/x/repo')?.branch).toBe('main')
  expect(locate(list, '/x/repo/src/deep')?.branch).toBe('main')
  expect(locate(list, '/x/repo/.claude/worktrees/probe-wt')?.branch).toBe('worktree-probe-wt')
  expect(locate(list, '/x/repo/.claude/worktrees/probe-wt/sub')?.branch).toBe('worktree-probe-wt')
  expect(locate(list, '/x/manual-wt-other')).toBeUndefined()
  expect(locate(list, '/elsewhere')).toBeUndefined()
})

test('locate: a trailing slash on either side finds the same record', () => {
  const list = parsePorcelain(PORCELAIN_SESSION)
  expect(locate(list, '/x/repo/.claude/worktrees/probe-wt/')?.branch).toBe('worktree-probe-wt')
  expect(normPath('/x/repo///')).toBe('/x/repo')
  expect(normPath('/')).toBe('/')
})

test('locate and findByPath: a trailing slash on a stored record path finds the same record', () => {
  const list: GitWorktree[] = [
    { path: '/x/repo/', branch: 'main', detached: false, bare: false },
    { path: '/x/repo/.claude/worktrees/probe-wt/', branch: 'worktree-probe-wt', detached: false, bare: false },
  ]
  expect(locate(list, '/x/repo/.claude/worktrees/probe-wt')?.branch).toBe('worktree-probe-wt')
  expect(locate(list, '/x/repo/.claude/worktrees/probe-wt/sub')?.branch).toBe('worktree-probe-wt')
  expect(findByPath(list, '/x/repo/.claude/worktrees/probe-wt')?.branch).toBe('worktree-probe-wt')
  expect(findByPath(list, '/x/repo/.claude/worktrees/probe-wt/')?.branch).toBe('worktree-probe-wt')
  expect(findByPath(list, '/x/repo/.claude/worktrees/probe-wt/sub')).toBeUndefined()
  expect(findByPath(list, '/x/repo/', new Set([list[0]!]))).toBeUndefined()
})

test('agentWorktreePath is the Claude convention under the main tree', () => {
  expect(agentWorktreePath('/x/repo', 'a94bdd45b56e2c631')).toBe('/x/repo/.claude/worktrees/agent-a94bdd45b56e2c631')
  expect(agentWorktreePath('/x/repo/', 'abc')).toBe('/x/repo/.claude/worktrees/agent-abc')
})

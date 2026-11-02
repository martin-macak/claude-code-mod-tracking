// Issue #255: git lists the canonical path of a worktree (`/private/var/...`), an agent can name it by a symlink alias
// (`/var/...`). The match rules take a canonical-path function, and the round fills a cache of it with async calls. Fake deps.
import { expect, test } from 'claude-code/testing'
import {
  agentWorktreePath,
  basename,
  findByPath,
  holds,
  locate,
  normPath,
  parsePorcelain,
  workflowWorktreePath,
} from '../core/lib/porcelain'
import { agentPaths, agentWorksIn, trackAgents } from '../trackers/auto/agents'
import { emptyAuto, pinRoot, recordSpawn } from '../trackers/auto/ledger'
import { makeRealResolver, REAL_CAP, REAL_TTL_MS, type RealCache, realOf, resolveReal } from '../trackers/auto/real'
import { AutoRound, type RoundDeps } from '../trackers/auto/round'
import type { AgentProof, AutoState, GitWorktree, LiveAgent } from './fixtures/contracts'
import { porcelain as gitPorcelain } from './fixtures/git'

const CANON = '/private/var/f/repo'
const ALIAS = '/var/f/repo'
const aliasOf = (p: string): string => {
  const n = normPath(p)
  return n === ALIAS || n.startsWith(`${ALIAS}/`) ? `/private${n}` : n
}

const rec = (path: string, branch: string): GitWorktree => ({ path, branch, detached: false, bare: false })
const LIST = [rec(CANON, 'main'), rec(`${CANON}/wt`, 'wt-b')]
const agent = (id: string, over: Partial<AgentProof> = {}): AgentProof => ({
  id,
  kind: 'subagent',
  label: id,
  spawnedAt: 1,
  cwd: CANON,
  ...over,
})
const state = (agents: AgentProof[]): AutoState => ({
  root: { cwd: CANON, at: 1, top: CANON },
  worktrees: [],
  agents,
  dismissed: [],
  snapshot: null,
})
const rowOf = (v: ReturnType<typeof trackAgents>, id: string) => v.rows.find(r => r.id === `ag:${id}`)!

test('locate, findByPath and holds join two spellings of one folder when given a canonical-path function', () => {
  const list = parsePorcelain('worktree /private/var/f/wt\nHEAD abc\nbranch refs/heads/wt\n\n')
  const real = (p: string): string => (normPath(p).startsWith('/var/') ? `/private${normPath(p)}` : normPath(p))
  expect(locate(list, '/var/f/wt')).toBeUndefined() // no function: the strings differ
  expect(locate(list, '/var/f/wt', real)?.branch).toBe('wt')
  expect(locate(list, '/var/f/wt/src/', real)?.branch).toBe('wt')
  expect(findByPath(list, '/var/f/wt', undefined, real)?.branch).toBe('wt')
  expect(findByPath(list, '/var/f/wt-other', undefined, real)).toBeUndefined()
  expect(holds('/private/var/f/wt', '/var/f/wt', real)).toBe(true)
  expect(holds('/var/f/wt', '/private/var/f/wt/x', real)).toBe(true)
  expect(holds('/var/f/wt', '/private/var/f/other', real)).toBe(false)
})

test('an agent whose cwd or worktreePath is a symlink alias of a listed worktree is placed there', () => {
  const s = state([agent('c', { cwd: `${ALIAS}/wt/src` }), agent('w', { cwd: undefined, worktreePath: `${ALIAS}/wt` })])
  const v = trackAgents(s, [], LIST, CANON, 5_000_000, undefined, aliasOf)
  expect(rowOf(v, 'c')).toMatchObject({ worktree: 'wt', branch: 'wt-b', worktreeLive: true })
  expect(rowOf(v, 'w')).toMatchObject({ worktree: 'wt', branch: 'wt-b', worktreeLive: true })
  expect(rowOf(trackAgents(s, [], LIST, CANON, 5_000_000), 'c').branch).toBe('main') // the old string rule misses it
})

test('agentWorksIn sees an agent whose cwd is a symlink alias of the record', () => {
  const s = { agents: [agent('x', { cwd: `${ALIAS}/wt` })], worktrees: [] }
  expect(agentWorksIn(s, LIST, CANON, LIST[1]!)).toBe(false)
  expect(agentWorksIn(s, LIST, CANON, LIST[1]!, aliasOf)).toBe(true)
})

test('resolveReal fills the cache once per path, skips a path that cannot be resolved and never rejects', async () => {
  const cache: RealCache = new Map()
  const asked: string[] = []
  const resolve = async (p: string): Promise<string | undefined> => {
    asked.push(p)
    if (p === '/gone') throw new Error('ENOENT')
    if (p === '/none') return undefined
    return p === ALIAS ? CANON : p
  }
  await resolveReal(resolve, cache, [`${ALIAS}/`, '/gone', '/none'], 0)
  expect(realOf(cache)(`${ALIAS}/`)).toBe(CANON)
  expect(realOf(cache)('/gone')).toBe('/gone') // a missing path stays as it is
  await resolveReal(resolve, cache, [ALIAS], 1)
  expect(asked.filter(p => p === ALIAS)).toHaveLength(1) // cached: asked once
})

test('resolveReal asks a path that failed again at the next call', async () => {
  const cache: RealCache = new Map()
  const asked: string[] = []
  const resolve = async (p: string): Promise<string | undefined> => {
    asked.push(p)
    if (p === '/gone') throw new Error('ENOENT')
    return undefined
  }
  await resolveReal(resolve, cache, ['/gone', '/none'], 0)
  await resolveReal(resolve, cache, ['/gone', '/none'], 1)
  expect(asked.filter(p => p === '/gone')).toHaveLength(2)
  expect(asked.filter(p => p === '/none')).toHaveLength(2)
})

test('resolveReal starts the cache again at the cap and never holds more than the cap', async () => {
  const cache: RealCache = new Map()
  const resolve = async (p: string): Promise<string | undefined> => `/r${p}`
  await resolveReal(
    resolve,
    cache,
    Array.from({ length: REAL_CAP }, (_, i) => `/p${i}`),
    0,
  )
  expect(cache.size).toBe(REAL_CAP)
  await resolveReal(resolve, cache, ['/new'], 1)
  expect([...cache.keys()]).toEqual(['/new'])
  const many = Array.from({ length: REAL_CAP + 40 }, (_, i) => `/q${i}`)
  await resolveReal(resolve, cache, many, 2)
  expect(cache.size).toBe(REAL_CAP)
})

test('resolveReal reads an entry again after its time to live, so a retargeted link does not keep its old match', async () => {
  const cache: RealCache = new Map()
  let target = '/old'
  const resolve = async (): Promise<string | undefined> => target
  await resolveReal(resolve, cache, ['/link'], 0)
  target = '/new'
  await resolveReal(resolve, cache, ['/link'], REAL_TTL_MS - 1)
  expect(realOf(cache)('/link')).toBe('/old')
  await resolveReal(resolve, cache, ['/link'], REAL_TTL_MS)
  expect(realOf(cache)('/link')).toBe('/new')
})

test('resolveReal drops an expired entry whose path no longer resolves', async () => {
  const cache: RealCache = new Map()
  let target: string | undefined = '/r'
  const resolve = async (): Promise<string | undefined> => target
  await resolveReal(resolve, cache, ['/p'], 0)
  expect(realOf(cache)('/p')).toBe('/r')
  target = undefined
  await resolveReal(resolve, cache, ['/p'], REAL_TTL_MS)
  expect(realOf(cache)('/p')).toBe('/p')
  expect(cache.has('/p')).toBe(false)
})

test('the master cwd, a convention path and a workflow path in the alias spelling are joined to their records', () => {
  const alias = (p: string): string => p.replace(CANON, ALIAS)
  const conv = alias(agentWorktreePath(CANON, 'c'))
  const wf = alias(workflowWorktreePath(CANON, 'wf_x', 2))
  const list = [...LIST, rec(conv, 'conv-b'), rec(wf, 'wf-b')]
  const agents = [
    agent('c', { cwd: undefined }),
    agent('w', { kind: 'workflow', workflow: { runId: 'wf_x', agentIndex: 2 }, cwd: undefined }),
  ]
  const s = state(agents)
  const v = trackAgents(s, null, list, `${ALIAS}/wt`, 5_000_000, undefined, aliasOf)
  expect(v.rows[0]).toMatchObject({ kind: 'master', worktree: 'wt', branch: 'wt-b' })
  expect(rowOf(v, 'c')).toMatchObject({ branch: 'conv-b', worktreeLive: true })
  expect(rowOf(v, 'w')).toMatchObject({ branch: 'wf-b', worktreeLive: true })
  expect(v.state.agents.find(a => a.id === 'w')?.worktreePath).toBe(`${CANON}/.claude/worktrees/${basename(wf)}`)
  const plain = trackAgents(s, null, list, `${ALIAS}/wt`, 5_000_000)
  expect(plain.rows[0]?.branch).toBeUndefined() // the old string rule misses all three
  expect(rowOf(plain, 'c').branch).toBeUndefined()
  expect(rowOf(plain, 'w').branch).toBeUndefined()
})

test('an alias worktreePath holds its path, so a second agent of the run does not take it', () => {
  const wfPath = workflowWorktreePath(CANON, 'wf_x', 2)
  const list = [...LIST, rec(wfPath, 'wf-b')]
  const mk = (id: string, over: Partial<AgentProof> = {}) =>
    agent(id, { kind: 'workflow', workflow: { runId: 'wf_x', agentIndex: 2 }, cwd: undefined, ...over })
  const s = state([mk('first', { worktreePath: wfPath.replace(CANON, ALIAS) }), mk('second')])
  const v = trackAgents(s, null, list, CANON, 5_000_000, undefined, aliasOf)
  expect(rowOf(v, 'first').branch).toBe('wf-b')
  expect(rowOf(v, 'second').branch).not.toBe('wf-b')
})

test('a proof that names the convention path of an agent by an alias keeps its branch on the dimmed row', () => {
  const proof = {
    path: agentWorktreePath(CANON, 'c').replace(CANON, ALIAS),
    branch: 'proof-b',
  } as AutoState['worktrees'][number]
  const s = { ...state([agent('c', { cwd: undefined })]), worktrees: [proof] }
  const v = trackAgents(s, null, LIST, CANON, 5_000_000, undefined, aliasOf)
  expect(rowOf(v, 'c')).toMatchObject({ branch: 'proof-b', worktreeLive: false })
  expect(rowOf(trackAgents(s, null, LIST, CANON, 5_000_000), 'c').branch).not.toBe('proof-b') // the old string rule misses it
})

test('a removed worktree that the proof names by an alias keeps its branch on the dimmed row', () => {
  const gone = `${CANON}/.claude/worktrees/agent-c`
  const proof = { path: gone.replace(CANON, ALIAS), branch: 'proof-b' } as AutoState['worktrees'][number]
  const s = { ...state([agent('c', { cwd: undefined, worktreePath: gone })]), worktrees: [proof] }
  const v = trackAgents(s, null, LIST, CANON, 5_000_000, undefined, aliasOf)
  expect(rowOf(v, 'c')).toMatchObject({ branch: 'proof-b', worktreeLive: false })
})

test('every path that the rules ask the resolver about is one that the round resolves (agentPaths)', () => {
  const wfPath = workflowWorktreePath(CANON, 'wf_x', 2)
  const conv = agentWorktreePath(CANON, 'c')
  const list = [...LIST, rec(wfPath, 'wf-b')]
  const proof = { path: `${CANON}/.claude/worktrees/gone`, branch: 'g' } as AutoState['worktrees'][number]
  // A proof that no agent names: the rules still compare it with each convention path, so the round must resolve it.
  const stray = { path: '/other/stray-proof', branch: 's' } as AutoState['worktrees'][number]
  const agents = [
    agent('c', { cwd: `${CANON}/wt/src` }),
    agent('p', { cwd: undefined, worktreePath: `${CANON}/.claude/worktrees/gone`, parentId: 'c' }),
    agent('w', { kind: 'workflow', workflow: { runId: 'wf_x', agentIndex: 2 }, cwd: undefined }),
    agent('b', { cwd: undefined, branch: 'wt-b' }),
  ]
  const s = { ...state(agents), worktrees: [proof, stray] }
  const asked = new Set<string>()
  const spy = (p: string): string => {
    asked.add(normPath(p))
    return normPath(p)
  }
  trackAgents(s, null, list, `${CANON}/wt`, 5_000_000, undefined, spy)
  agentWorksIn(s, list, `${CANON}/wt`, LIST[1]!, spy)
  const known = new Set(agentPaths(agents, [proof, stray], list, `${CANON}/wt`).map(normPath))
  expect(asked.has(normPath(stray.path))).toBe(true)
  expect([...asked].filter(p => !known.has(p))).toEqual([])
  expect(known.has(normPath(conv))).toBe(true)
})

function rig(realPath: RoundDeps['realPath'], spawnCwd = `${ALIAS}/.claude/worktrees/wt/src`, lateSpawn = false) {
  const base = pinRoot(emptyAuto(), CANON, 1)
  let auto: AutoState = base
  const spawned = (): AutoState =>
    recordSpawn(auto, { agentId: 'a', description: 'd', subagentType: 'general-purpose' }, 2, spawnCwd)
  if (!lateSpawn) auto = spawned()
  let loads = 0
  const deps: RoundDeps = {
    now: () => 1_000_000,
    // A late spawn: the hook records the agent after the first read of the round.
    load: async () => {
      loads += 1
      if (lateSpawn && loads === 2) auto = spawned()
      return auto
    },
    save: async change => {
      auto = change(auto)
      return auto
    },
    git: async argv =>
      argv[0] === 'rev-parse'
        ? { exitCode: 0, stdout: `${CANON}\n`, stderr: '' }
        : { exitCode: 0, stdout: gitPorcelain(CANON, ['wt', 'wt-b']), stderr: '' },
    listAgents: async () => [{ id: 'a', status: 'running' }] as LiveAgent[],
    sessionCwd: async () => CANON,
    ...(realPath ? { realPath } : {}),
  }
  return { round: new AutoRound(deps), auto: () => auto }
}

const agentRow = (t: ReturnType<typeof rig>) => t.auto().snapshot!.agents.find(r => r.id === 'ag:a')!

test('a round places an agent whose cwd is a symlink alias and asks each path once', async () => {
  const asked: string[] = []
  const t = rig(async p => {
    asked.push(p)
    return aliasOf(p)
  })
  await t.round.run()
  expect(agentRow(t).worktree).toBe('wt')
  const n = asked.length
  await t.round.run()
  expect(asked.length).toBe(n) // the second round reads the cache
})

test('a round whose path resolver rejects places an agent by the plain path', async () => {
  const reject = async (): Promise<string | undefined> => {
    throw new Error('no fs')
  }
  const plain = rig(reject, `${CANON}/.claude/worktrees/wt/src`)
  expect(await plain.round.run()).toBe(true)
  expect(agentRow(plain)).toMatchObject({ worktree: 'wt', branch: 'wt-b' }) // the plain spelling matches
  const alias = rig(reject)
  expect(await alias.round.run()).toBe(true)
  expect(agentRow(alias).worktree).not.toBe('wt') // the alias misses, and the agent falls to the place of the session
  expect(agentRow(alias).worktree).toBe(basename(CANON))
})

test('an agent that the ledger gains during the round is resolved in that round', async () => {
  const t = rig(async p => aliasOf(p), undefined, true)
  expect(await t.round.run()).toBe(true)
  expect(agentRow(t).worktree).toBe('wt')
})

test('makeRealResolver resolves every requested path of a round that is over the cache cap, and keeps at most the cap', async () => {
  const total = REAL_CAP + 90
  const paths = Array.from({ length: total }, (_, i) => `/v/p${i}`)
  const last = paths[total - 1] as string
  const r = makeRealResolver(
    async p => `/private${p}`,
    () => 0,
  )
  const real = await r.resolve(paths)
  expect(real(last)).toBe(`/private${last}`)
  expect(real(paths[0] as string)).toBe(`/private${paths[0]}`)
})

test('resolveReal gives every requested path and keeps at most the cap between calls', async () => {
  const cache: RealCache = new Map()
  const paths = Array.from({ length: REAL_CAP + 90 }, (_, i) => `/q${i}`)
  const round = await resolveReal(async p => `/r${p}`, cache, paths, 0)
  expect(round.size).toBe(paths.length)
  expect(cache.size).toBeLessThanOrEqual(REAL_CAP)
})

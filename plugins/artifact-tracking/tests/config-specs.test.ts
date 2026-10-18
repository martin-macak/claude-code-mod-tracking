// The config specs: GLOBAL_SCHEMA and one schema per tracker. Pins every default to the value of d391552 (the LIMITS
// object before L4) and every min and max to the Defaults table of the L4 plan, which is the source of truth: the spec
// gives no bounds. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2 (decisions C1 to C3, C13 to C15).
import { expect, test } from 'claude-code/testing'
import type { ConfigSpec } from '../core/interfaces/config'
import type { JsonObject } from '../core/interfaces/items'
import { GLOBAL_DEFAULTS, GLOBAL_SCHEMA, normaliseGlobal } from '../core/lib/global-config'
import { defaultsOf, type Schema } from '../core/lib/normalise'
import { buildTrackers } from '../trackers'
import { ARTIFACT_DEFAULTS, ARTIFACT_SCHEMA, artifactConfig } from '../trackers/artifact/config'
import { AUTO_DEFAULTS, AUTO_SCHEMA, autoConfig } from '../trackers/auto/config'
import { FILE_DEFAULTS, FILE_SCHEMA, fileConfig } from '../trackers/file/config'
import { GITHUB_DEFAULTS, GITHUB_SCHEMA, githubConfig, PR_LANE_DEFAULTS } from '../trackers/github/config'
import { JIRA_DEFAULTS, JIRA_SCHEMA, jiraConfig } from '../trackers/jira/config'
import { PROCESSES_DEFAULTS, PROCESSES_SCHEMA, processesConfig } from '../trackers/processes/config'
import { REPOS_DEFAULTS, REPOS_SCHEMA, reposConfig } from '../trackers/repos/config'
import { WEB_DEFAULTS, WEB_SCHEMA, webConfig } from '../trackers/web/config'
import { LIMITS } from './fixtures/limits'

/** Every spec by tracker id, with its schema and defaults. */
const SPECS = {
  github: { schema: GITHUB_SCHEMA, defaults: GITHUB_DEFAULTS, spec: githubConfig },
  jira: { schema: JIRA_SCHEMA, defaults: JIRA_DEFAULTS, spec: jiraConfig },
  web: { schema: WEB_SCHEMA, defaults: WEB_DEFAULTS, spec: webConfig },
  artifact: { schema: ARTIFACT_SCHEMA, defaults: ARTIFACT_DEFAULTS, spec: artifactConfig },
  file: { schema: FILE_SCHEMA, defaults: FILE_DEFAULTS, spec: fileConfig },
  repos: { schema: REPOS_SCHEMA, defaults: REPOS_DEFAULTS, spec: reposConfig },
  processes: { schema: PROCESSES_SCHEMA, defaults: PROCESSES_DEFAULTS, spec: processesConfig },
  auto: { schema: AUTO_SCHEMA, defaults: AUTO_DEFAULTS, spec: autoConfig },
} as const

/** The specs as one type, so a test can walk them. */
const loose = (): ConfigSpec<JsonObject>[] => Object.values(SPECS).map(s => s.spec as unknown as ConfigSpec<JsonObject>)

const THE_LIMITS_OF_D391552 = {
  maxItems: 500,
  keepSessions: 20,
  staleMs: 300000,
  pendingStaleMs: 60000,
  tickMs: 30000,
  captureDebounceMs: 1000,
  flushMs: 1500,
  breakerThreshold: 3,
  breakerOpenMs: 300000,
  toolTimeoutMs: 30000,
  acliConcurrency: 3,
  epicChildLimit: 50,
  autoDebounceMs: 750,
  gitTimeoutMs: 5000,
  discoveryTimeoutMs: 10000,
  workflowIdleMs: 3600000,
  maxBranches: 12,
  headPrsPerBranch: 5,
  basePrsPerBranch: 10,
  closingRefsPerPr: 10,
  maxBodyRefs: 50,
  maxAutoItems: 100,
  maxProofs: 100,
  maxAgents: 200,
  maxDismissed: 500,
  maxMentionsPerRow: 20,
  maxRepos: 50,
  maxRepoAgents: 8,
  maxRepoQueue: 32,
  maxPinned: 100,
}

test('the defaults equal the LIMITS of d391552', () => {
  expect(LIMITS).toEqual(THE_LIMITS_OF_D391552)
})

test("the values outside LIMITS equal today's constants", () => {
  expect(GITHUB_DEFAULTS.chunkSize).toBe(50)
  expect(GITHUB_DEFAULTS.shortRefKeywords).toEqual(['github', 'bug', 'issue', 'issues', 'enhancement', 'chore'])
  expect(GLOBAL_DEFAULTS.tools.probeTimeoutMs).toBe(10000)
  expect(PROCESSES_DEFAULTS.probeTimeoutMs).toBe(10000)
  expect(AUTO_DEFAULTS.gitTimeoutMs).toBe(REPOS_DEFAULTS.gitTimeoutMs)
  expect(GLOBAL_DEFAULTS.store.maxBytes).toBe(3000000)
  expect(GLOBAL_DEFAULTS.ui).toEqual({ maxRows: 300, sectionRows: 50 })
})

test('PR_LANE_DEFAULTS agrees with AUTO_DEFAULTS and GITHUB_DEFAULTS', () => {
  expect(PR_LANE_DEFAULTS.maxBranches).toBe(AUTO_DEFAULTS.maxBranches)
  expect(PR_LANE_DEFAULTS.maxAutoItems).toBe(AUTO_DEFAULTS.maxAutoItems)
  expect(PR_LANE_DEFAULTS.headPrsPerBranch).toBe(GITHUB_DEFAULTS.headPrsPerBranch)
  expect(PR_LANE_DEFAULTS.basePrsPerBranch).toBe(GITHUB_DEFAULTS.basePrsPerBranch)
  expect(PR_LANE_DEFAULTS.closingRefsPerPr).toBe(GITHUB_DEFAULTS.closingRefsPerPr)
})

test('the slices hold exactly the keys of the Defaults table', () => {
  expect(Object.keys(WEB_DEFAULTS)).toEqual(['enabled'])
  expect(Object.keys(ARTIFACT_DEFAULTS)).toEqual(['enabled'])
  expect(Object.keys(GITHUB_DEFAULTS)).toEqual([
    'enabled',
    'chunkSize',
    'pendingStaleMs',
    'discoveryTimeoutMs',
    'closingRefsPerPr',
    'headPrsPerBranch',
    'basePrsPerBranch',
    'maxBodyRefs',
    'shortRefKeywords',
  ])
  expect(Object.keys(JIRA_DEFAULTS)).toEqual(['enabled', 'concurrency', 'epicChildLimit'])
  expect(Object.keys(FILE_DEFAULTS)).toEqual(['enabled', 'maxMentionsPerRow'])
  expect(Object.keys(REPOS_DEFAULTS)).toEqual(['enabled', 'maxRepos', 'maxRepoAgents', 'maxRepoQueue', 'gitTimeoutMs'])
  expect(Object.keys(PROCESSES_DEFAULTS)).toEqual(['enabled', 'probeTimeoutMs'])
  expect(Object.keys(AUTO_DEFAULTS)).toEqual([
    'enabled',
    'debounceMs',
    'gitTimeoutMs',
    'workflowIdleMs',
    'maxBranches',
    'maxAutoItems',
    'maxProofs',
    'maxAgents',
  ])
  for (const { defaults } of Object.values(SPECS)) expect('prompt' in defaults).toBe(false)
})

test('every slice has enabled first, on by default', () => {
  for (const { schema, defaults } of Object.values(SPECS)) {
    expect(Object.keys(schema)[0]).toBe('enabled')
    expect((defaults as { enabled: boolean }).enabled).toBe(true)
  }
})

test('every spec normalises its own defaults with no problem', () => {
  const out: string[] = []
  const warn = (p: string) => void out.push(p)
  for (const spec of loose()) expect(spec.normalise(spec.defaults, spec.defaults, warn)).toEqual(spec.defaults)
  expect(normaliseGlobal(GLOBAL_DEFAULTS, warn)).toEqual(GLOBAL_DEFAULTS)
  expect(out).toEqual([])
})

test('every spec normalises an empty slice to its defaults', () => {
  const out: string[] = []
  for (const spec of loose()) expect(spec.normalise({}, spec.defaults, p => void out.push(p))).toEqual(spec.defaults)
  expect(normaliseGlobal({}, p => void out.push(p))).toEqual(GLOBAL_DEFAULTS)
  expect(out).toEqual([])
})

/** The Defaults table of the L4 plan: [path, min, max] of every whole-number key. */
const TABLE: readonly (readonly [string, number, number])[] = [
  ['global.refresh.tickMs', 5000, 600000],
  ['global.refresh.staleMs', 30000, 86400000],
  ['global.refresh.captureDebounceMs', 100, 60000],
  ['global.refresh.flushMs', 100, 60000],
  ['global.tools.timeoutMs', 1000, 300000],
  ['global.tools.probeTimeoutMs', 1000, 120000],
  ['global.tools.breaker.threshold', 1, 100],
  ['global.tools.breaker.openMs', 1000, 86400000],
  ['global.store.keepSessions', 1, 200],
  ['global.store.maxItems', 200, 5000],
  ['global.store.maxDismissed', 50, 5000],
  ['global.store.maxBytes', 100000, 4000000],
  ['global.ui.maxRows', 50, 1000],
  ['global.ui.sectionRows', 5, 300],
  ['trackers.github.chunkSize', 1, 100],
  ['trackers.github.pendingStaleMs', 10000, 3600000],
  ['trackers.github.discoveryTimeoutMs', 1000, 120000],
  ['trackers.github.closingRefsPerPr', 1, 50],
  ['trackers.github.headPrsPerBranch', 1, 50],
  ['trackers.github.basePrsPerBranch', 1, 50],
  ['trackers.github.maxBodyRefs', 1, 200],
  ['trackers.jira.concurrency', 1, 10],
  ['trackers.jira.epicChildLimit', 1, 500],
  ['trackers.file.maxMentionsPerRow', 0, 200],
  ['trackers.repos.maxRepos', 1, 500],
  ['trackers.repos.maxRepoAgents', 1, 50],
  ['trackers.repos.maxRepoQueue', 1, 256],
  ['trackers.repos.gitTimeoutMs', 500, 60000],
  ['trackers.processes.probeTimeoutMs', 1000, 120000],
  ['trackers.auto.debounceMs', 50, 60000],
  ['trackers.auto.gitTimeoutMs', 500, 60000],
  ['trackers.auto.workflowIdleMs', 60000, 86400000],
  ['trackers.auto.maxBranches', 1, 50],
  ['trackers.auto.maxAutoItems', 1, 200],
  ['trackers.auto.maxProofs', 10, 1000],
  ['trackers.auto.maxAgents', 10, 2000],
]

/** The whole-number rules of a schema, with the path of each. */
function intRules(schema: Schema, prefix: string): [string, number, number][] {
  const found: [string, number, number][] = []
  for (const [key, rule] of Object.entries(schema)) {
    const path = `${prefix}.${key}`
    if (rule.kind === 'obj') found.push(...intRules(rule.of, path))
    else if (rule.kind === 'int') found.push([path, rule.min, rule.max])
  }
  return found
}

/** `{ a: { b: v } }` for the path `a.b`. */
const nest = (path: readonly string[], v: number): JsonObject =>
  path.length === 1 ? { [path[0]!]: v } : { [path[0]!]: nest(path.slice(1), v) }

const at = (v: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, key) => (cur as Record<string, unknown>)[key], v)

test('each int key clamps at its min and max', () => {
  const found = [
    ...intRules(GLOBAL_SCHEMA, 'global'),
    ...Object.entries(SPECS).flatMap(([id, s]) => intRules(s.schema, `trackers.${id}`)),
  ]
  const key = (r: readonly [string, number, number]) => r.join('|')
  expect(found.map(key).sort()).toEqual(TABLE.map(key).sort())
  for (const [path, min, max] of TABLE) {
    const parts = path.split('.')
    // global.* goes through normaliseGlobal; trackers.<id>.* through the tracker's own spec.
    const run = (v: number) => {
      const out: string[] = []
      if (parts[0] === 'global') {
        const value = normaliseGlobal(nest(parts.slice(1), v), p => void out.push(p))
        return { got: at(value, parts.slice(1)), out }
      }
      const spec = SPECS[parts[1] as keyof typeof SPECS].spec as unknown as ConfigSpec<JsonObject>
      const value = spec.normalise(nest(parts.slice(2), v), spec.defaults, p => void out.push(p))
      return { got: at(value, parts.slice(2)), out }
    }
    const low = run(min - 1)
    expect([path, low.got]).toEqual([path, min])
    expect(low.out).toHaveLength(1)
    expect(low.out[0]!.endsWith(`Using ${min}.`)).toBe(true)
    const high = run(max + 1)
    expect([path, high.got]).toEqual([path, max])
    expect(high.out).toHaveLength(1)
    expect(high.out[0]!.endsWith(`Using ${max}.`)).toBe(true)
    // The bounds themselves are valid.
    expect(run(min).out).toEqual([])
    expect(run(max).out).toEqual([])
  }
})

test('GLOBAL_DEFAULTS is the defaults of GLOBAL_SCHEMA and is frozen', () => {
  expect(GLOBAL_DEFAULTS).toEqual(defaultsOf(GLOBAL_SCHEMA))
  expect(Object.isFrozen(GLOBAL_DEFAULTS)).toBe(true)
  expect(Object.isFrozen(GLOBAL_DEFAULTS.tools.breaker)).toBe(true)
})

test('normaliseGlobal names the dotted path and keeps unknown keys', () => {
  const out: string[] = []
  const value = normaliseGlobal({ refresh: { tickMs: 1, tickMss: 2 }, typo: 1 }, p => void out.push(p))
  expect(value.refresh.tickMs).toBe(5000)
  expect((value as unknown as Record<string, unknown>).typo).toBe(1)
  expect(out).toEqual([
    'global.refresh.tickMs: 1 is below the min 5000. Using 5000.',
    'global.refresh.tickMss: unknown key. The mod keeps it and ignores it.',
    'global.typo: unknown key. The mod keeps it and ignores it.',
  ])
})

test('the github keyword list is lowercased, deduped and capped at 32 words', () => {
  const out: string[] = []
  const got = githubConfig.normalise(
    { shortRefKeywords: ['Ticket', 'ticket', 'two words'] },
    githubConfig.defaults,
    p => void out.push(p),
  )
  expect(got.shortRefKeywords).toEqual(['ticket'])
  expect(out).toEqual(['shortRefKeywords: "two words" is not a valid word. The mod leaves it out.'])
  const many = Array.from({ length: 40 }, (_, i) => `w${i}`)
  expect(githubConfig.normalise({ shortRefKeywords: many }, githubConfig.defaults, () => {}).shortRefKeywords).toEqual(
    many.slice(0, 32),
  )
})

test('buildTrackers uses the specs', () => {
  const list = buildTrackers({
    autoGithub: {
      discovery: {} as never,
      ready: async () => false,
      repo: async () => null,
      hosts: () => [],
      lane: () => ({ headPrsPerBranch: 5, basePrsPerBranch: 10, closingRefsPerPr: 10, maxBodyRefs: 50 }),
    },
  })
  expect(list.map(t => t.id).sort()).toEqual(Object.keys(SPECS).sort())
  for (const tracker of list) {
    expect(tracker.config).toBe(SPECS[tracker.id as keyof typeof SPECS].spec)
    expect((tracker.config.defaults as { enabled?: boolean }).enabled).toBe(true)
  }
})

test('the defaults of every spec are deeply frozen', () => {
  for (const { defaults } of Object.values(SPECS)) expect(Object.isFrozen(defaults)).toBe(true)
  expect(Object.isFrozen(GITHUB_DEFAULTS.shortRefKeywords)).toBe(true)
})

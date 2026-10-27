// The global values reach the code that used a LIMITS constant: the capture debounce, the tool timeouts, the breaker,
// the stale times of an item and the item cap. Each test uses a value that is not the default, so it fails on the old
// constant. Plan: L4 Task 7 (decisions C2, C5).
import { expect, test } from 'claude-code/testing'
import { RefreshCoordinator } from '../core/infra/refresh'
import { CircuitBreaker } from '../core/lib/circuit-breaker'
import type { ToolTimeouts } from '../core/lib/tool'
import { GhTool } from '../trackers/github/gh-tool'
import type { GitHubRecord, GitHubToolApi, ItemRecord, JiraToolApi, RunInit, Runner, Tools } from './fixtures/contracts'
import { MENTIONED } from './fixtures/reasons'
import { enforceCap, hydrate, MAX_PINNED, mergeRefs } from './fixtures/registry'

const NOW = 10_000_000
const base = { sources: ['prompt' as const], reasons: MENTIONED, firstSeen: 1, lastSeen: 1, seenCount: 1 }

// ---------------------------------------------------------------- the capture debounce

function coordinatorWorld(debounceMs?: () => number) {
  const timers: { ms: number; fn: () => void | Promise<void>; cancelled: boolean }[] = []
  let loads = 0
  let now = NOW
  const coordinator = new RefreshCoordinator({
    now: () => now,
    load: async () => {
      loads++
      return []
    },
    save: async () => {},
    lanes: [],
    after: (ms, fn) => {
      const t = { ms, fn, cancelled: false }
      timers.push(t)
      return {
        cancel() {
          t.cancelled = true
        },
      }
    },
    ...(debounceMs ? { debounceMs } : {}),
  })
  return {
    coordinator,
    timers,
    loads: () => loads,
    advance(ms: number) {
      now += ms
    },
  }
}

test('the capture debounce follows debounceMs()', async () => {
  const w = coordinatorWorld(() => 5000)
  w.coordinator.kick('capture')
  expect(w.timers.map(t => t.ms)).toEqual([5000])
  expect(w.loads()).toBe(0) // nothing runs before the timer fires
  await w.timers[0]!.fn()
  expect(w.loads()).toBe(1)
})

test('an overdue capture timer is replaced after twice debounceMs(), not twice the default', () => {
  const w = coordinatorWorld(() => 5000)
  w.coordinator.kick('capture')
  w.advance(3000) // over twice the old 1000, under twice 5000
  w.coordinator.kick('capture')
  expect(w.timers.length).toBe(1)
  w.advance(8000) // 11000 since the timer was armed: over twice 5000
  w.coordinator.kick('capture')
  expect(w.timers.length).toBe(2)
  expect(w.timers[0]!.cancelled).toBe(true)
})

test('with no debounceMs the debounce is 1000, as before', () => {
  const w = coordinatorWorld()
  w.coordinator.kick('capture')
  expect(w.timers.map(t => t.ms)).toEqual([1000])
})

// ---------------------------------------------------------------- the tool timeouts

function runner(): { run: Runner; calls: { argv: string[]; init: RunInit | undefined }[] } {
  const calls: { argv: string[]; init: RunInit | undefined }[] = []
  const run: Runner = async (argv, init) => {
    calls.push({ argv: [...argv], init })
    if (argv[1] === 'repo') return { exitCode: 0, stdout: '{"nameWithOwner":"o/r"}', stderr: '' }
    return { exitCode: 0, stdout: argv[1] === 'api' ? '{"data":{}}' : 'gh version 2.102.0 (2026-09-30)', stderr: '' }
  }
  return { run, calls }
}

test('a tool run uses timeouts().timeoutMs and the probe uses probeTimeoutMs', async () => {
  const { run, calls } = runner()
  const timeouts: ToolTimeouts = () => ({ timeoutMs: 1234, probeTimeoutMs: 567 })
  const tool = new GhTool(run, () => NOW, undefined, { timeouts })
  await tool.probe()
  await tool.checkHost('ghe.example')
  await tool.defaultRepo()
  await tool.refreshItems([
    { key: 'gh:github.com/o/r#5', host: 'github.com', owner: 'o', repo: 'r', number: 5, type: 'unknown' },
  ])
  const timeoutOf = (pick: (argv: string[]) => boolean) => calls.find(c => pick(c.argv))?.init?.timeoutMs
  expect(timeoutOf(a => a[1] === '--version')).toBe(567)
  expect(timeoutOf(a => a[1] === 'auth')).toBe(1234)
  expect(timeoutOf(a => a[1] === 'repo')).toBe(1234)
  expect(timeoutOf(a => a[1] === 'api')).toBe(1234)
})

test('the timeouts are read at each call, so a changed file shows at the next one', async () => {
  const { run, calls } = runner()
  let t = { timeoutMs: 1000, probeTimeoutMs: 2000 }
  const tool = new GhTool(run, () => NOW, undefined, { timeouts: () => t })
  await tool.checkHost('a.example')
  t = { timeoutMs: 4000, probeTimeoutMs: 2000 }
  await tool.checkHost('b.example')
  expect(calls.map(c => c.init?.timeoutMs)).toEqual([1000, 4000])
})

test('with no timeouts the tool uses 30000 and 10000, as before', async () => {
  const { run, calls } = runner()
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  await tool.checkHost('ghe.example')
  expect(calls.map(c => c.init?.timeoutMs)).toEqual([10000, 30000])
})

// ---------------------------------------------------------------- the breaker

test('the breaker defaults are 3 and 300000', () => {
  const b = new CircuitBreaker()
  b.failure(1000)
  b.failure(1000)
  expect(b.state).toBe('closed')
  b.failure(1000)
  expect(b.state).toBe('open')
  expect(b.openUntil).toBe(1000 + 300000)
})

test('a breaker built from the given numbers opens at the threshold and waits openMs', () => {
  const b = new CircuitBreaker(1, 2500)
  b.failure(100)
  expect(b.openUntil).toBe(2600)
})

// ---------------------------------------------------------------- the stale times of an item

const prRecord = (over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  ...base,
  category: 'github',
  key: 'gh:github.com/o/r#7',
  url: 'https://github.com/o/r/pull/7',
  label: 'o/r#7',
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  number: 7,
  type: 'pr',
  checks: 'pending',
  refreshedAt: NOW,
  ...over,
})
const tools = { gh: {} as GitHubToolApi, acli: {} as JiraToolApi } as Tools

test('isDue follows ttl().staleMs; a pending PR follows pendingStaleMs', () => {
  const ttl = () => ({ staleMs: 1000, pendingStaleMs: 10 })
  const settled = hydrate(prRecord({ checks: 'success' }), tools, ttl)
  expect(settled.isDue(NOW + 999)).toBe(false)
  expect(settled.isDue(NOW + 1000)).toBe(true)
  const pending = hydrate(prRecord(), tools, ttl)
  expect(pending.isDue(NOW + 9)).toBe(false)
  expect(pending.isDue(NOW + 10)).toBe(true)
})

test('a Jira item follows ttl().staleMs', () => {
  const rec = {
    ...base,
    category: 'jira',
    key: 'jira:acme.atlassian.net/ISS-1',
    url: 'https://acme.atlassian.net/browse/ISS-1',
    label: 'ISS-1',
    site: 'acme.atlassian.net',
    issueKey: 'ISS-1',
    trackOnly: false,
    children: [],
    refreshedAt: NOW,
  } as ItemRecord
  const item = hydrate(rec, tools, () => ({ staleMs: 2000, pendingStaleMs: 1 }))
  expect(item.isDue(NOW + 1999)).toBe(false)
  expect(item.isDue(NOW + 2000)).toBe(true)
})

test('the ttl is read at each call, so a changed file shows at the next check', () => {
  let staleMs = 100_000
  const item = hydrate(prRecord({ checks: 'success' }), tools, () => ({ staleMs, pendingStaleMs: 1 }))
  expect(item.isDue(NOW + 50_000)).toBe(false)
  staleMs = 40_000
  expect(item.isDue(NOW + 50_000)).toBe(true)
})

test('with no ttl an item goes stale after 300000 and a pending PR after 60000, as before', () => {
  expect(hydrate(prRecord({ checks: 'success' }), tools).isDue(NOW + 299_999)).toBe(false)
  expect(hydrate(prRecord({ checks: 'success' }), tools).isDue(NOW + 300_000)).toBe(true)
  expect(hydrate(prRecord(), tools).isDue(NOW + 59_999)).toBe(false)
  expect(hydrate(prRecord(), tools).isDue(NOW + 60_000)).toBe(true)
})

// ---------------------------------------------------------------- the item cap

const web = (i: number, over: Partial<ItemRecord> = {}): ItemRecord =>
  ({
    ...base,
    category: 'web',
    key: `web:https://h${i}.example/`,
    url: `https://h${i}.example/`,
    label: `h${i}`,
    lastSeen: i,
    ...over,
  }) as ItemRecord

test('the merge cap follows the cap argument and MAX_PINNED stays 100', () => {
  expect(MAX_PINNED).toBe(100)
  const list = Array.from({ length: 6 }, (_, i) => web(i + 1))
  const merged = mergeRefs(
    list,
    [{ category: 'web', url: 'https://new.example/', label: 'new' }],
    { source: 'prompt', at: 99 },
    4,
  )
  expect(merged.list.length).toBe(4)
  expect(merged.list.map(r => r.key)).toContain('web:https://new.example/') // the new record never goes
  // 150 pinned records and a cap of 10: the cap keeps the newest 100 and drops the rest.
  const pinned = Array.from({ length: 150 }, (_, i) => web(i + 1, { priority: 'high' }))
  const kept = enforceCap(pinned, 10, new Set(), () => undefined)
  expect(kept.length).toBe(100)
  expect(kept.map(r => r.lastSeen).sort((a, b) => a - b)[0]).toBe(51)
})

test('with no cap the merge cap is 500, as before', () => {
  const list = Array.from({ length: 500 }, (_, i) => web(i + 1))
  const merged = mergeRefs(list, [{ category: 'web', url: 'https://new.example/', label: 'n' }], {
    source: 'prompt',
    at: 1000,
  })
  expect(merged.list.length).toBe(500)
})

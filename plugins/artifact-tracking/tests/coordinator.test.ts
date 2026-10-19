// RefreshCoordinator: due picking, debounce, re-entry guard, force, logged-out tools, errors. Pure, fakes only.
import { expect, test } from 'claude-code/testing'
import type { CoordinatorDeps } from '../core/infra/coordinator'
import { RefreshCoordinator } from '../core/infra/coordinator'
import type {
  GitHubTarget,
  GitHubToolApi,
  HydratedItem,
  ItemRecord,
  JiraTarget,
  JiraToolApi,
  Tools,
} from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'

const NOW = 10_000_000
const base = { sources: ['prompt' as const], firstSeen: 1, lastSeen: 1, seenCount: 1 }

const gh = (n: number, extra: Partial<ItemRecord> = {}): ItemRecord =>
  ({
    ...base,
    category: 'github',
    key: `gh:github.com/o/r#${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    label: `#${n}`,
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    number: n,
    type: 'issue',
    ...extra,
  }) as ItemRecord

const jira = (k: string, extra: Partial<ItemRecord> = {}): ItemRecord =>
  ({
    ...base,
    category: 'jira',
    key: `jira:acme.atlassian.net/${k}`,
    url: `https://acme.atlassian.net/browse/${k}`,
    label: k,
    site: 'acme.atlassian.net',
    issueKey: k,
    trackOnly: false,
    children: [],
    ...extra,
  }) as ItemRecord

const web = (u: string): ItemRecord =>
  ({
    ...base,
    category: 'web',
    key: `web:${u}`,
    url: u,
    label: u,
  }) as ItemRecord

const fresh = { refreshedAt: NOW - 1000 }

/** A hydrated item built from a record. Due: never refreshed or stale. Refreshable: not web, not not-found. */
function hydrate(rec: ItemRecord): HydratedItem {
  // biome-ignore lint/suspicious/noExplicitAny: a loose test double that refers to itself
  const item: any = {
    ...rec,
    canRefresh: () => item.category !== 'web' && item.error?.kind !== 'not-found',
    isDue: (now: number) =>
      item.error?.kind !== 'not-found' && (item.refreshedAt === undefined || now - item.refreshedAt >= LIMITS.staleMs),
    refresh: async () => {},
    toRecord: () => {
      const { canRefresh, isDue, refresh, toRecord, ...r } = item
      return r as ItemRecord
    },
  }
  return item as HydratedItem
}

type Calls = { gh: string[][]; acli: string[][] }
type ToolOpts = { ghCan?: boolean; acliCan?: boolean; throwGh?: boolean }

function fakeTools(opts: ToolOpts = {}) {
  const calls: Calls = { gh: [], acli: [] }
  const resets: string[] = []
  const ghTool = {
    name: 'gh',
    isAvailable: true,
    canCall: () => opts.ghCan !== false,
    refreshItems: async (items: GitHubTarget[]) => {
      calls.gh.push(items.map(i => i.key))
      if (opts.throwGh) throw new Error('boom')
      for (const i of items) {
        i.refreshedAt = NOW
        i.title = `t${i.number}`
        delete i.error
      }
    },
    reset: () => {
      resets.push('gh')
    },
    status: () => ({ name: 'gh', available: true, loggedIn: true, breaker: 'closed' }),
    isHostAuthed: () => true,
    checkHost: async () => true,
    defaultRepo: async () => null,
  } as unknown as GitHubToolApi
  const acliTool = {
    name: 'acli',
    isAvailable: true,
    canCall: () => opts.acliCan !== false,
    refreshItems: async (items: JiraTarget[]) => {
      calls.acli.push(items.map(i => i.key))
      for (const i of items) {
        i.refreshedAt = NOW
        i.status = 'Done'
        delete i.error
      }
    },
    reset: () => {
      resets.push('acli')
    },
    status: () => ({ name: 'acli', available: true, loggedIn: true, breaker: 'closed' }),
    activeSite: 'acme.atlassian.net',
    loadActiveSite: async () => 'acme.atlassian.net',
  } as unknown as JiraToolApi
  const tools: Tools = { gh: ghTool, acli: acliTool }
  return { tools, calls, resets }
}

function setup(records: ItemRecord[], toolOpts: ToolOpts = {}, over: Partial<CoordinatorDeps> = {}) {
  const t = fakeTools(toolOpts)
  const saved: ItemRecord[][] = []
  const errors: unknown[] = []
  let runs = 0
  const timers: { ms: number; fn: () => void | Promise<void>; cancelled: boolean }[] = []
  const deps: CoordinatorDeps = {
    now: () => NOW,
    load: async () => records,
    save: async r => {
      saved.push(r)
    },
    hydrate,
    tools: t.tools,
    after: (ms, fn) => {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        },
      }
    },
    onRun: () => {
      runs++
    },
    onError: e => {
      errors.push(e)
    },
    ...over,
  }
  const c = new RefreshCoordinator(deps)
  return { c, ...t, saved, errors, timers, runs: () => runs }
}

const fire = async (timer: { fn: () => void | Promise<void> }) => {
  await timer.fn()
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('only due and refreshable items are refreshed; web links never are', async () => {
  const s = setup([gh(1), gh(2, fresh), web('https://example.com/'), gh(3)])
  const r = await s.c.runDue()
  expect(r).toEqual({ refreshed: 2, skipped: false })
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#1', 'gh:github.com/o/r#3']])
  expect(s.calls.acli).toEqual([])
  expect(s.saved.length).toBe(1)
  expect(s.saved[0]!.map(x => x.key)).toEqual(['gh:github.com/o/r#1', 'gh:github.com/o/r#3'])
})

test('a Markdown file item is never refreshed, not even by a manual kick', async () => {
  const file = {
    ...base,
    category: 'file',
    key: 'file:/work/a.md',
    url: '/work/a.md',
    label: '/work/a.md',
    created: true,
    edits: 0,
    views: 0,
    mentions: 0,
  } as ItemRecord
  const s = setup([file, gh(1)])
  expect(await s.c.runDue()).toEqual({ refreshed: 1, skipped: false })
  s.c.kick('manual')
  await flush()
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#1'], ['gh:github.com/o/r#1']])
  expect(s.calls.acli).toEqual([])
})

test('artifacts are never refreshed, not even by a forced run; no tool is called for them', async () => {
  // The stub item says an artifact can refresh: only the coordinator keeps it out.
  const artifact = { ...base, category: 'artifact', key: 'art:x', url: 'https://claude.ai/artifact/x', label: 'x' }
  const s = setup([artifact as ItemRecord, gh(1)])
  expect(await s.c.runDue({ force: true })).toEqual({ refreshed: 1, skipped: false })
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#1']])
  expect(s.calls.acli).toEqual([])
})

test('GitHub and Jira items go to their own tool in one call each', async () => {
  const s = setup([gh(1), jira('ISS-1'), gh(2), jira('ISS-2')])
  await s.c.runDue()
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#1', 'gh:github.com/o/r#2']])
  expect(s.calls.acli).toEqual([['jira:acme.atlassian.net/ISS-1', 'jira:acme.atlassian.net/ISS-2']])
})

test('save gets the records changed by refreshItems', async () => {
  const s = setup([gh(7), jira('ISS-7')])
  await s.c.runDue()
  const recs = s.saved[0]!
  const g = recs.find(r => r.category === 'github')!
  const j = recs.find(r => r.category === 'jira')!
  expect(g).toMatchObject({ number: 7, title: 't7', refreshedAt: NOW })
  expect(j).toMatchObject({ issueKey: 'ISS-7', status: 'Done', refreshedAt: NOW })
  expect('canRefresh' in g).toBe(false)
})

test('three capture kicks before the timer fires give one run with all keys', async () => {
  const s = setup([gh(1), gh(2), gh(3), gh(4)])
  s.c.kick('capture', ['gh:github.com/o/r#1'])
  s.c.kick('capture', ['gh:github.com/o/r#2'])
  s.c.kick('capture', ['gh:github.com/o/r#3'])
  expect(s.timers.length).toBe(1)
  expect(s.timers[0]!.ms).toBe(LIMITS.captureDebounceMs)
  expect(s.calls.gh).toEqual([])
  await fire(s.timers[0]!)
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#1', 'gh:github.com/o/r#2', 'gh:github.com/o/r#3']])
  // pending is cleared: the next capture starts a new timer
  s.c.kick('capture', ['gh:github.com/o/r#4'])
  expect(s.timers.length).toBe(2)
  await fire(s.timers[1]!)
  expect(s.calls.gh[1]).toEqual(['gh:github.com/o/r#4'])
})

test('open and tick kicks run all due items', async () => {
  const s = setup([gh(1), jira('ISS-1')])
  s.c.kick('open')
  await flush()
  expect(s.calls.gh.length).toBe(1)
  expect(s.calls.acli.length).toBe(1)
  s.c.kick('tick')
  await flush()
  expect(s.runs()).toBe(2)
})

test('a runDue during a run is queued and runs once; two queued requests fold into one', async () => {
  let release!: () => void
  const gate = new Promise<void>(res => {
    release = res
  })
  let loads = 0
  const records = [gh(1), gh(2), gh(3)]
  const s = setup(
    records,
    {},
    {
      load: async () => {
        loads++
        if (loads === 1) await gate
        return records
      },
    },
  )
  const first = s.c.runDue()
  await flush()
  expect(s.c.busy).toBe(true)
  const q1 = await s.c.runDue({ keys: ['gh:github.com/o/r#2'] })
  const q2 = await s.c.runDue({ keys: ['gh:github.com/o/r#3'] })
  expect(q1).toEqual({ refreshed: 0, skipped: true })
  expect(q2).toEqual({ refreshed: 0, skipped: true })
  release()
  const r = await first
  expect(r.skipped).toBe(false)
  expect(s.c.busy).toBe(false)
  // run 1 refreshes all three, then exactly one queued run for the union of keys #2 and #3
  expect(loads).toBe(2)
  expect(s.calls.gh.length).toBe(2)
  expect(s.calls.gh[1]).toEqual(['gh:github.com/o/r#2', 'gh:github.com/o/r#3'])
})

test('a queued request without keys widens the folded run to all items, and force is sticky', async () => {
  let release!: () => void
  const gate = new Promise<void>(res => {
    release = res
  })
  let loads = 0
  const records = [gh(1), gh(2, { error: { kind: 'not-found', message: 'x', at: 1 } })]
  const s = setup(
    records,
    {},
    {
      load: async () => {
        loads++
        if (loads === 1) await gate
        return records
      },
    },
  )
  const first = s.c.runDue({ keys: ['gh:github.com/o/r#1'] })
  await flush()
  void s.c.runDue({ keys: ['gh:github.com/o/r#1'] })
  void s.c.runDue({ force: true })
  void s.c.runDue({ keys: ['gh:github.com/o/r#1'] })
  release()
  await first
  await flush()
  expect(loads).toBe(2)
  expect(s.calls.gh[1]).toEqual(['gh:github.com/o/r#1', 'gh:github.com/o/r#2'])
})

test('manual kick resets both tools and force-refreshes a not-found item', async () => {
  const nf = gh(5, { error: { kind: 'not-found', message: 'gone', at: 1 }, refreshedAt: NOW - 1000 })
  const s = setup([nf, gh(6, fresh)])
  await s.c.runDue()
  expect(s.calls.gh).toEqual([]) // not due, not-found
  s.c.kick('manual')
  expect(s.resets).toEqual(['gh', 'acli'])
  await flush()
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#5', 'gh:github.com/o/r#6']])
  const rec = s.saved.at(-1)!.find(r => r.key === nf.key)!
  expect(rec.error).toBeUndefined()
})

test('a tool that cannot be called gets no items, and onRun still runs', async () => {
  const s = setup([gh(1), jira('ISS-1')], { ghCan: false })
  const r = await s.c.runDue()
  expect(s.calls.gh).toEqual([])
  expect(s.calls.acli).toEqual([['jira:acme.atlassian.net/ISS-1']])
  expect(r.refreshed).toBe(1)
  expect(s.runs()).toBe(1)

  const none = setup([gh(1), jira('ISS-1')], { ghCan: false, acliCan: false })
  const r2 = await none.c.runDue()
  expect(r2).toEqual({ refreshed: 0, skipped: false })
  expect(none.saved).toEqual([])
  expect(none.runs()).toBe(1)
})

test('a throwing refreshItems goes to onError; runDue resolves and busy ends false', async () => {
  const s = setup([gh(1), jira('ISS-1')], { throwGh: true })
  const r = await s.c.runDue()
  expect(r.skipped).toBe(false)
  expect(s.errors.length).toBe(1)
  expect((s.errors[0] as Error).message).toBe('boom')
  expect(s.c.busy).toBe(false)
  // the next run still works
  await s.c.runDue()
  expect(s.calls.acli.length).toBe(2)
})

test('errors from load, save and onRun are reported, never thrown', async () => {
  const s1 = setup(
    [gh(1)],
    {},
    {
      load: async () => {
        throw new Error('load')
      },
    },
  )
  await s1.c.runDue()
  expect(s1.errors.length).toBe(1)
  expect(s1.c.busy).toBe(false)

  const s2 = setup(
    [gh(1)],
    {},
    {
      save: async () => {
        throw new Error('save')
      },
    },
  )
  await s2.c.runDue()
  expect((s2.errors[0] as Error).message).toBe('save')

  const s3 = setup(
    [gh(1)],
    {},
    {
      onRun: () => {
        throw new Error('onRun')
      },
    },
  )
  await s3.c.runDue()
  expect((s3.errors[0] as Error).message).toBe('onRun')
  expect(s3.c.busy).toBe(false)
})

test('runDue with keys skips other items', async () => {
  const s = setup([gh(1), gh(2), jira('ISS-1')])
  const r = await s.c.runDue({ keys: ['gh:github.com/o/r#2'] })
  expect(r.refreshed).toBe(1)
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#2']])
  expect(s.calls.acli).toEqual([])
})

test('idle() settles when the running run and its queued run are done', async () => {
  let release!: () => void
  const gate = new Promise<void>(res => {
    release = res
  })
  let loads = 0
  const records = [gh(1)]
  const s = setup(
    records,
    {},
    {
      load: async () => {
        loads++
        if (loads === 1) await gate
        return records
      },
    },
  )
  const first = s.c.runDue()
  await flush()
  const queued = await s.c.runDue({ force: true })
  expect(queued.skipped).toBe(true)
  let idle = false
  const waiting = s.c.idle().then(() => {
    idle = true
  })
  await flush()
  expect(idle).toBe(false) // the run is still in flight
  release()
  await waiting
  await first
  expect(idle).toBe(true)
  expect(loads).toBe(2) // the forced run happened before idle() settled
  expect(s.c.busy).toBe(false)
  await s.c.idle() // nothing runs: settles at once
})

test('a capture timer that never fired is re-armed by the next capture kick', async () => {
  let clock = NOW
  const s = setup([gh(1), gh(2)], {}, { now: () => clock })
  s.c.kick('capture', ['gh:github.com/o/r#1'])
  expect(s.timers.length).toBe(1) // the engine refused it: this one never fires
  clock += LIMITS.captureDebounceMs / 2
  s.c.kick('capture', ['gh:github.com/o/r#2'])
  expect(s.timers.length).toBe(1) // still within the debounce window: the same timer
  clock += LIMITS.captureDebounceMs * 3
  s.c.kick('capture', ['gh:github.com/o/r#2'])
  expect(s.timers.length).toBe(2)
  expect(s.timers[0]!.cancelled).toBe(true)
  await fire(s.timers[1]!)
  expect(s.calls.gh).toEqual([['gh:github.com/o/r#1', 'gh:github.com/o/r#2']])
})

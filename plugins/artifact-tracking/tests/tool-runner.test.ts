// ToolRunner: one handle per ToolSpec, the probe, the timeouts, the breaker and the published statuses. Pure, fakePorts.
// Plan: L5 Task 3, K13.
import { expect, test } from 'claude-code/testing'
import { ToolRunner, type ToolRunnerDeps } from '../core/infra/tools'
import type { GlobalConfig } from '../core/interfaces/config'
import type { RunOpts, RunResult } from '../core/interfaces/ports'
import type { Breaker, ToolSpec } from '../core/interfaces/tracker'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { GH_TOOL, ghClient } from '../trackers/github/client'
import { ACLI_TOOL, acliClient } from '../trackers/jira/client'
import { fakePorts } from './fixtures/ports'

declare function setTimeout(fn: () => void, ms: number): unknown
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const res = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })
const SPECS = [
  { owner: 'github', spec: GH_TOOL },
  { owner: 'jira', spec: ACLI_TOOL },
]
const withBreaker = (breaker: GlobalConfig['tools']['breaker']): GlobalConfig => ({
  ...GLOBAL_DEFAULTS,
  tools: { ...GLOBAL_DEFAULTS.tools, breaker },
})

/** A runner over fakePorts. `opts` holds the RunOpts of every call; `g.value` is read at each call. */
function rig(o: { global?: GlobalConfig; live?: (owner: string) => boolean; reject?: boolean } = {}) {
  const w = fakePorts()
  const g = { value: o.global ?? GLOBAL_DEFAULTS }
  const opts: (RunOpts | undefined)[] = []
  w.run = argv => {
    if (argv[1] === '--version' && argv[0] === 'gh') return res('gh version 2.80.0\n')
    if (argv[1] === '--version' && argv[0] === 'acli') return res('', 127, 'not found')
    return undefined
  }
  const deps: ToolRunnerDeps = {
    run: (argv, init) => {
      opts.push(init)
      if (o.reject) return Promise.reject(new Error('boom'))
      return w.ports.run(argv, init)
    },
    now: () => w.clock.now,
    global: () => g.value,
    tools: w.ports.state.tools,
    log: w.ports.log,
    ...(o.live ? { live: o.live } : {}),
  }
  const runner = new ToolRunner(deps)
  runner.build(SPECS)
  return { w, g, opts, runner }
}

test('build makes one handle per spec; a duplicate id keeps the first and logs one line', () => {
  const { w, runner } = rig()
  runner.build([{ owner: 'jira', spec: GH_TOOL }])
  expect(w.logs).toEqual(['tools: jira declares gh, owned by github. The later one is off.'])
  expect(runner.port('jira').handle('gh')).toBeUndefined()
  expect(runner.port('github').handle('gh')?.id).toBe('gh')
  expect(runner.port('jira').handle('acli')?.id).toBe('acli')
  expect(runner.port('github').handle('acli')).toBeUndefined() // another tracker's tool
})

test('start probes every handle once without waiting and publishes once', async () => {
  const { w, runner } = rig()
  runner.start()
  await runner.settle()
  await turn()
  expect(w.calls).toEqual([
    ['gh', '--version'],
    ['acli', '--version'],
  ])
  expect(w.state.get('tools')).toEqual({
    gh: { name: 'gh', available: true, version: 'gh version 2.80.0', loggedIn: null, breaker: 'closed' },
    acli: { name: 'acli', available: false, loggedIn: null, breaker: 'closed', lastError: 'not found' },
  })
  expect(w.stateSets.tools).toBe(1)
  expect(Object.keys(w.state.get('tools') as object)).toEqual(['gh', 'acli'])
})

test('start probes only the owners that are live; settle waits for those probes and no other', async () => {
  const { w, runner } = rig({ live: owner => owner !== 'github' })
  runner.start()
  await runner.settle()
  await turn()
  expect(w.calls).toEqual([['acli', '--version']])
  // The off tool still has its handle and its idle status. Nothing started a probe for it.
  expect((w.state.get('tools') as Record<string, { available: boolean | null }>).gh?.available).toBeNull()
  expect(runner.port('github').handle('gh')?.isAvailable).toBe(false)
})

test('settle before start waits for nothing, and a later start probes once', async () => {
  const { w, runner } = rig()
  await runner.settle()
  expect(w.calls).toEqual([])
  runner.start()
  runner.start() // a second start keeps the probes it has
  await runner.settle()
  expect(w.calls.length).toBe(2)
})

test('publish writes nothing when only lastRunAt moved', async () => {
  const { w, runner } = rig()
  await runner.publish()
  expect(w.stateSets.tools).toBe(1)
  w.clock.now = 500
  const gh = runner.port('github').handle('gh')!
  await gh.exec(['gh', 'api'])
  expect(gh.status().lastRunAt).toBe(500)
  await runner.publish()
  expect(w.stateSets.tools).toBe(1)
  gh.record('tool-failure', 'down') // a shown field moves
  await runner.publish()
  expect(w.stateSets.tools).toBe(2)
})

test('the probe uses the spec argv and probeTimeoutMs; exec uses timeoutMs', async () => {
  const { opts, runner, w } = rig()
  const spec: ToolSpec = { id: 'x', probe: ['x', 'version'], timeoutMs: 1234 }
  runner.build([{ owner: 'xs', spec }])
  const x = runner.port('xs').handle('x')!
  await x.probe()
  await x.exec(['x', 'a'])
  expect(w.calls).toEqual([
    ['x', 'version'],
    ['x', 'a'],
  ])
  expect(opts.map(o => o?.timeoutMs)).toEqual([10000, 1234])
})

test('without a spec timeout the exec timeout is global.tools.timeoutMs, read at each call', async () => {
  const { g, opts, runner } = rig()
  const gh = runner.port('github').handle('gh')!
  await gh.exec(['gh', 'a'])
  g.value = { ...g.value, tools: { ...g.value.tools, timeoutMs: 4000, probeTimeoutMs: 2000 } }
  await gh.exec(['gh', 'b'])
  await gh.probe()
  expect(opts.map(o => o?.timeoutMs)).toEqual([30000, 4000, 2000])
  await gh.exec(['gh', 'c'], { timeoutMs: 77 }) // a call can still pick its own
  expect(opts.at(-1)?.timeoutMs).toBe(77)
})

test('the breaker reads global.tools.breaker; a spec override wins', () => {
  const { runner } = rig({ global: withBreaker({ threshold: 1, openMs: 1000 }) })
  const gh = runner.port('github').handle('gh')!
  gh.record('tool-failure')
  expect(gh.status().breaker).toBe('open')

  runner.build([{ owner: 'xs', spec: { id: 'x', probe: ['x'], breaker: { threshold: 2 } } }])
  const x = runner.port('xs').handle('x')!
  x.record('tool-failure')
  expect(x.status().breaker).toBe('closed')
  x.record('tool-failure')
  expect(x.status().breaker).toBe('open')
  expect(x.status().openUntil).toBe(1000) // the spec left openMs to the global value
})

test('a handle hands out spare breakers with the numbers of its tool: the breaker of a host that is not the home host', () => {
  const { runner } = rig({ global: withBreaker({ threshold: 1, openMs: 1000 }) })
  const gh = runner.port('github').handle('gh')!
  const spare = gh.spare()
  expect(gh.spare()).not.toBe(spare) // a new one each time
  spare.failure(10)
  expect(spare.state).toBe('open') // threshold 1
  expect(spare.openUntil).toBe(1010) // openMs 1000
  expect(gh.status().breaker).toBe('closed') // the tool breaker is not the spare
  runner.build([{ owner: 'xs', spec: { id: 'x', probe: ['x'], breaker: { threshold: 2 } } }])
  const other = runner.port('xs').handle('x')!.spare()
  other.failure(0)
  expect(other.state).toBe('closed') // the spec override reaches the spare too
  other.failure(0)
  expect(other.state).toBe('open')
})

test('a GhTool reads the configured breaker numbers for a host that is not the home host', async () => {
  const { runner, w } = rig({ global: withBreaker({ threshold: 1, openMs: 1000 }) })
  const handle = runner.port('github').handle('gh')!
  await handle.probe()
  w.run = argv => {
    if (argv[1] === 'api') throw new Error('timeout')
    return res('gh version 2.80.0\n')
  }
  const gh = ghClient(handle, {
    now: () => w.clock.now,
    limits: () => ({ chunkSize: 50, closingRefsPerPr: 10, discoveryTimeoutMs: 30000 }),
  })
  expect(await gh.graphql('ghe.corp', 'query {}')).toMatchObject({ ok: false, kind: 'transport' })
  expect(await gh.graphql('ghe.corp', 'query {}')).toEqual({ ok: false, kind: 'blocked' }) // threshold 1: one failure opens it
  expect(handle.status().breaker).toBe('closed') // and the breaker of the tool is not touched
})

test('a breaker factory in the deps builds the breaker of each handle from the merged numbers', () => {
  const made: { threshold: number; openMs: number }[] = []
  const seen: string[] = []
  const fake: Breaker = {
    state: 'closed',
    openUntil: undefined,
    peek: () => true,
    allows: () => true,
    success: () => void seen.push('success'),
    failure: now => void seen.push(`failure@${now}`),
    reset: () => void seen.push('reset'),
  }
  const w = fakePorts({ now: 7 })
  const runner = new ToolRunner({
    run: w.ports.run,
    now: () => w.clock.now,
    global: () => GLOBAL_DEFAULTS,
    tools: w.ports.state.tools,
    log: w.ports.log,
    breaker: limits => {
      made.push(limits)
      return fake
    },
  })
  runner.build([{ owner: 'xs', spec: { id: 'x', probe: ['x'], breaker: { openMs: 5000 } } }])
  expect(made).toEqual([{ threshold: 3, openMs: 5000 }])
  const x = runner.port('xs').handle('x')!
  x.record('tool-failure')
  x.record('ok')
  x.reset()
  expect(seen).toEqual(['failure@7', 'success', 'reset'])
})

test('the breaker numbers are read once, at build', () => {
  const { g, runner } = rig()
  g.value = withBreaker({ threshold: 1, openMs: 1000 })
  const gh = runner.port('github').handle('gh')!
  gh.record('tool-failure') // built with the default 3
  expect(gh.status().breaker).toBe('closed')
})

test('resetAll forgets loggedIn false and closes every breaker', async () => {
  const { runner } = rig({ global: withBreaker({ threshold: 1, openMs: 60000 }) })
  const gh = runner.port('github').handle('gh')!
  const acli = runner.port('jira').handle('acli')!
  gh.record('auth')
  acli.record('tool-failure')
  expect(gh.status()).toMatchObject({ loggedIn: false, breaker: 'open' })
  expect(acli.status().breaker).toBe('open')
  runner.resetAll()
  expect(gh.status().loggedIn).toBeNull()
  expect(gh.status().breaker).toBe('half-open') // an open breaker lets one call through at once
  expect(acli.status().breaker).toBe('half-open')
  await gh.exec(['gh', 'api'])
  gh.record('ok') // that call worked
  expect(gh.status()).toMatchObject({ loggedIn: true, breaker: 'closed' })
})

test('run of an undeclared tool id is the raw runner', async () => {
  const { w, runner, opts } = rig()
  const before = JSON.stringify(runner.port('github').handle('gh')!.status())
  const out = await runner.port('repos').run('git', ['git', 'status'], { cwd: '/w', timeoutMs: 5000 })
  expect(out.exitCode).toBe(1) // the fake answers "unexpected call"
  expect(w.calls).toEqual([['git', 'status']])
  expect(opts).toEqual([{ cwd: '/w', timeoutMs: 5000 }])
  expect(JSON.stringify(runner.port('github').handle('gh')!.status())).toBe(before)
})

test('a handle carries the site it was given', () => {
  const { runner } = rig()
  const acli = runner.port('jira').handle('acli')!
  expect(acli.status().site).toBeUndefined()
  acli.setSite('acme.atlassian.net')
  expect(acli.status().site).toBe('acme.atlassian.net')
  acli.setSite(undefined)
  expect(acli.status().site).toBeUndefined()
})

test('a handle exposes peek (the breaker alone) and raw (no breaker, no record)', async () => {
  const { w, runner } = rig({ global: withBreaker({ threshold: 1, openMs: 60000 }), reject: true })
  const gh = runner.port('github').handle('gh')!
  expect(gh.peek(0)).toBe(true) // canCall is false until a probe succeeds; peek asks the breaker only
  expect(gh.canCall(0)).toBe(false)
  await expect(gh.raw(['gh', 'auth', 'status'])).rejects.toThrow('boom')
  expect(gh.status().breaker).toBe('closed') // raw records nothing
  expect(await gh.exec(['gh', 'api'])).toBeNull() // exec records a rejection
  expect(gh.status()).toMatchObject({ breaker: 'open', lastError: 'boom' })
  expect(gh.peek(0)).toBe(false)
  expect(gh.peek(60000)).toBe(true)
  expect(w.calls).toEqual([]) // the rig rejected before the fake saw a call
})

test('a GhTool over a handle feeds that handle breaker', async () => {
  const { runner, w } = rig({ reject: true })
  const gh = ghClient(runner.port('github').handle('gh')!, {
    now: () => w.clock.now,
    limits: () => ({ chunkSize: 50, closingRefsPerPr: 10, discoveryTimeoutMs: 30000 }),
  })
  const target = () => ({
    key: 'gh:github.com/o/r#5',
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    number: 5,
    type: 'unknown' as const,
  })
  for (let i = 0; i < 3; i++) await gh.refreshItems([target()])
  await runner.publish()
  expect((w.state.get('tools') as Record<string, { breaker: string }>).gh?.breaker).toBe('open')
  expect(gh.canCall(0)).toBe(false)
  expect(
    ghClient(runner.port('github').handle('gh')!, {
      now: () => 0,
      limits: () => ({ chunkSize: 1, closingRefsPerPr: 1, discoveryTimeoutMs: 1 }),
    }),
  ).toBe(gh) // memoised per handle
})

test('an AcliTool over a handle writes its site to that handle', async () => {
  const { runner, w } = rig()
  w.run = argv => (argv[1] === 'jira' ? res('Site: Acme.Atlassian.net\n') : undefined)
  const handle = runner.port('jira').handle('acli')!
  const acli = acliClient(handle, { now: () => w.clock.now, limits: () => ({ concurrency: 4, epicChildLimit: 50 }) })
  expect(acliClient(handle, { now: () => 0, limits: () => ({ concurrency: 1, epicChildLimit: 1 }) })).toBe(acli)
  expect(await acli.loadActiveSite()).toBe('acme.atlassian.net')
  expect(handle.status().site).toBe('acme.atlassian.net')
  expect(acli.status()).toEqual(handle.status())
  acli.reset()
  expect(handle.status().site).toBeUndefined() // a reset forgets the site, so the next use reads it again (#225)
  expect(await acli.loadActiveSite()).toBe('acme.atlassian.net')
  expect(handle.status().site).toBe('acme.atlassian.net')
})

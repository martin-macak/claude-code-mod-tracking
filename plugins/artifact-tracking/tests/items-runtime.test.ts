// The item runtime on fakePorts: the tools and the coordinator it builds at start, the session repo, the statuses it
// publishes, the tick, `/track refresh` and `/track prio`, and the facet the auto tracker's PR lane uses.
// Each case mirrors the kit test of the same subject. Plan: L3 Task 11, D13, D16.
import { expect, test } from 'claude-code/testing'
import type { GitHubTarget } from '../hooks/contracts'
import { ItemRuntime } from '../hooks/items/runtime'
import { GHE_AUTH_STATUS_STDERR } from './fixtures/gh'
import { graphqlCalls, itemsWorld, promptRow, res, sleep, until } from './fixtures/items'

const versionCalls = (calls: string[][], tool: string) => calls.filter(c => c[0] === tool && c[1] === '--version')

test('start probes gh and acli once and publishes the statuses once', async () => {
  const t = itemsWorld()
  expect(t.rt.ready).toBe(false)
  await t.rt.start(t.ctx)
  expect(t.rt.ready).toBe(true)
  await until(() => t.w.state.has('tools'), 'the published statuses')
  expect(versionCalls(t.w.calls, 'gh').length).toBe(1)
  expect(versionCalls(t.w.calls, 'acli').length).toBe(1)
  const tools = t.w.state.get('tools') as unknown as Record<string, { available: boolean | null }>
  expect(tools.gh?.available).toBe(true)
  expect(tools.acli?.available).toBe(true)
  expect(t.w.stateSets.tools).toBe(1)
  await t.rt.settleProbes() // nothing the pane shows changed: no second write (A22)
  expect(t.w.stateSets.tools).toBe(1)
})

test('a second start keeps the tools and the coordinator (D16)', async () => {
  const t = itemsWorld()
  await t.started()
  await t.rt.capture(promptRow('see https://github.com/cli/cli/pull/14640'))
  await t.rt.start(t.ctx)
  expect(versionCalls(t.w.calls, 'gh').length).toBe(1)
  // The capture debounce armed by the first start's coordinator still fires once.
  const before = graphqlCalls(t.w.calls).length
  await t.w.clock.advance(1010)
  await until(() => graphqlCalls(t.w.calls).length === before + 1, 'one refresh')
  await sleep(10)
  expect(graphqlCalls(t.w.calls).length).toBe(before + 1)
})

test('start re-keys web rows of artifact URLs on a warm list (R13)', async () => {
  const t = itemsWorld()
  t.w.state.set('items', [
    {
      key: 'web:https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo',
      category: 'web',
      url: 'https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo',
      label: 'x',
      sources: ['response'],
      firstSeen: 1,
      lastSeen: 1,
      seenCount: 1,
    },
  ] as never)
  await t.started()
  expect(t.list().map(r => r.category)).toEqual(['artifact'])
})

test('ensureRepo publishes session.repo and github.hosts, once per session', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  expect(rt.sessionRepo).toBeUndefined()
  await rt.ensureRepo()
  await rt.ensureRepo()
  expect(rt.sessionRepo).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(t.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(t.facts.read('github.hosts')).toEqual([])
})

test('a session with no repo is null, and a lookup that fails is null too', async () => {
  const t = itemsWorld({ remote: null, run: argv => (argv[1] === 'repo' ? res('', 1, 'no repo') : undefined) })
  const rt = await t.started()
  await rt.ensureRepo()
  expect(rt.sessionRepo).toBeNull()
  expect(t.facts.read('session.repo')).toBeUndefined()
  const u = itemsWorld({
    remote: null,
    run: argv => (argv[1] === 'repo' ? Promise.reject(new Error('cannot start')) : undefined),
  })
  await (await u.started()).ensureRepo()
  expect(u.rt.sessionRepo).toBeNull()
})

test('an ssh alias is not kept as the session repo; gh repo view resolves it', async () => {
  const t = itemsWorld({
    remote: { host: 'github-work', owner: 'o', repo: 'r' },
    run: argv => (argv[1] === 'auth' && argv.includes('github-work') ? res('', 1, GHE_AUTH_STATUS_STDERR) : undefined),
  })
  const rt = await t.started()
  await rt.ensureRepo()
  expect(rt.sessionRepo).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(t.facts.read('github.hosts')).toEqual([])
})

test('a host that gh knows is kept, with its name in github.hosts', async () => {
  const t = itemsWorld({ remote: { host: 'ghe.example', owner: 'o', repo: 'r' } })
  const rt = await t.started()
  await rt.ensureRepo()
  expect(rt.sessionRepo).toEqual({ host: 'ghe.example', owner: 'o', repo: 'r' })
  expect(t.facts.read('github.hosts')).toEqual(['ghe.example'])
})

test('gh repo view on another host is checked, and dropped when gh is not logged in there', async () => {
  const t = itemsWorld({
    remote: null,
    run: argv => {
      if (argv[1] === 'repo') return res('{"nameWithOwner":"o/r"}')
      return undefined
    },
  })
  const rt = await t.started()
  await rt.ensureRepo()
  expect(rt.sessionRepo).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
})

test('a non-github host is checked without blocking start', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = itemsWorld({
    remote: { host: 'ghe.example', owner: 'o', repo: 'r' },
    run: async argv => {
      if (argv[1] === 'auth') await gate
      return undefined
    },
  })
  await t.started() // resolves while the auth answer is outstanding
  const lookup = t.rt.ensureRepo()
  await sleep(10)
  expect(t.rt.sessionRepo).toBeUndefined()
  release()
  await lookup
  expect(t.rt.sessionRepo?.host).toBe('ghe.example')
})

test('sessionChanged resets the repo and publishes the statuses again', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.ensureRepo()
  t.w.state.delete('tools') // a /clear resets $.state
  await rt.sessionChanged({ from: 'a', to: 'b', kind: 'clear' })
  expect(rt.sessionRepo).toBeUndefined()
  expect(t.facts.read('session.repo')).toBeUndefined()
  const tools = t.w.state.get('tools') as unknown as Record<string, unknown>
  expect(Object.keys(tools)).toEqual(['gh', 'acli'])
  await rt.ensureRepo() // looked up again for the new session
  expect(rt.sessionRepo?.repo).toBe('web')
})

test('a stored copy load keeps a repo found earlier: only the switch forgets it', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.ensureRepo()
  t.w.session.repo = { host: 'github.com', owner: 'other', repo: 'thing' } // what a new lookup would find
  await rt.slot.restore([] as never, 'load') // a cold start after a lazy start is the same session
  expect(rt.sessionRepo?.repo).toBe('web')
  await rt.sessionChanged({ from: 'a', to: 'b', kind: 'resume' }) // the manager tells the host first in a switch
  await rt.slot.restore([] as never, 'load')
  await until(() => rt.sessionRepo?.repo === 'thing', 'the lookup of the new session')
})

test('tick finds the repo and kicks the coordinator', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/9'))
  expect(graphqlCalls(t.w.calls).length).toBe(0)
  await rt.tick()
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the tick refresh')
  expect(rt.sessionRepo?.repo).toBe('web')
  await until(() => (t.list()[0] as { title?: string } | undefined)?.title === 'Web nine', 'the saved title')
})

test('a tick whose repo lookup fails still kicks the refresh', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/9'))
  const spy = rt as unknown as { ensureRepo(): Promise<void> }
  spy.ensureRepo = () => Promise.reject(new Error('boom'))
  await rt.tick()
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the tick refresh')
})

test('kick open refreshes the due items', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/9'))
  rt.kick('open')
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the refresh')
})

test('refreshAll waits for a run in flight, then runs once more', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = itemsWorld({
    run: async argv => {
      if (argv[1] === 'api') await gate
      return undefined
    },
  })
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/9'))
  rt.kick('open') // a run starts and waits at the gate
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the first run')
  let done = false
  const all = rt.refreshAll().then(() => {
    done = true
  })
  await sleep(15)
  expect(done).toBe(false)
  release()
  await all
  expect(done).toBe(true)
  expect(graphqlCalls(t.w.calls).length).toBe(2)
})

test('a refresh that finds an item gone drops it and keeps it in the dismiss list', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/404'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#404'])
  await rt.refreshAll()
  expect(t.keys()).toEqual([])
  expect(t.dismissed.has('gh:github.com/acme/web#404')).toBe(true)
})

test('a refusing dismiss list does not fail the refresh', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  t.ctx.dismiss.add = () => Promise.reject(new Error('refused'))
  await rt.capture(promptRow('see https://github.com/acme/web/issues/404'))
  await rt.refreshAll()
  expect(t.keys()).toEqual([])
})

test('prio sets a level by ref and says not-tracked otherwise', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/9'))
  expect(await rt.prio('#9', 'high')).toBe('ok')
  expect((t.list()[0] as { priority?: string }).priority).toBe('high')
  expect(await rt.prio('#9', 'auto')).toBe('ok')
  expect((t.list()[0] as { priority?: string }).priority).toBeUndefined()
  expect(await rt.prio('#99', 'high')).toBe('not-tracked')
})

test('setPriority marks a row by its id', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://docs.example/a'))
  await rt.setPriority('web:https://docs.example/a', 'low')
  expect((t.list()[0] as { priority?: string }).priority).toBe('low')
})

test('touchFile tracks a Markdown file by a Write result; a failed call adds nothing', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  const created = {
    result: {
      type: 'create',
      filePath: '/work/plan.md',
      content: '# x',
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    },
  }
  await rt.touchFile('Write', { isError: true, result: 'denied' }, undefined)
  expect(t.keys()).toEqual([])
  await rt.touchFile('Write', created, undefined)
  expect(t.keys()).toEqual(['file:/work/plan.md'])
  await new ItemRuntime(t.w.ports.state).touchFile('Write', created, undefined) // not started: nothing to do
})

test('before start the runtime does nothing it cannot do', async () => {
  const t = itemsWorld()
  const rt = t.rt
  await rt.settleProbes()
  await rt.refreshAll()
  await rt.tick()
  rt.kick('open')
  rt.refresh(['k'])
  rt.dispose()
  expect(t.w.calls).toEqual([])
  expect(rt.ready).toBe(false)
  expect(await rt.list()).toEqual([])
})

test('the autoGithub facet rejects before start', async () => {
  const t = itemsWorld()
  const gh = t.rt.autoGithub
  expect(gh.hosts()).toEqual([])
  expect(gh.discovery.isAvailable).toBe(false)
  expect(gh.discovery.name).toBe('gh')
  await expect(gh.ready()).rejects.toThrow('gh: not ready')
  await expect(gh.repo()).rejects.toThrow('gh: not ready')
  expect(() => gh.discovery.status()).toThrow('gh: not ready')
  expect(() => gh.discovery.reset()).toThrow('gh: not ready')
  expect(() => gh.discovery.canCall(0)).toThrow('gh: not ready')
})

test('the autoGithub facet serves the tool and the repo after start', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  const gh = rt.autoGithub
  expect(await gh.ready()).toBe(true)
  expect(gh.discovery.isAvailable).toBe(true)
  expect(await gh.repo()).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(gh.hosts()).toEqual([])
  expect(gh.discovery.canCall(0)).toBe(true)
  expect(gh.discovery.status().name).toBe('gh')
  expect(await gh.discovery.checkHost('github.com')).toBe(true)
  expect(gh.discovery.isHostAuthed('github.com')).toBe(true)
  expect((await gh.discovery.defaultRepo())?.repo).toBe('web')
  const target: GitHubTarget = {
    key: 'gh:github.com/acme/web#5',
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: 5,
    type: 'unknown',
  }
  await gh.discovery.refreshItems([target])
  expect(target.state).toBe('open')
  const q = await gh.discovery.graphql('github.com', '{ viewer { login } }')
  expect(q).toBeDefined()
  gh.discovery.reset()
  expect(rt.autoGithub).toBe(gh)
})

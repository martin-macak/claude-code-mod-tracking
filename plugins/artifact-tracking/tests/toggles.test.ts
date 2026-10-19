// The tracker toggles in the item service and in the pane sections: an item kind that the config turned off runs no CLI,
// claims its spans and drops them (so a GitHub URL never becomes a web link), and leaves no record behind at start,
// replay, load or carry. Plan: L4 Task 6 (decisions C4, C12).
import { expect, test } from 'claude-code/testing'
import { transcriptItems } from '../core/infra/replay'
import { NO_VIEW } from '../core/infra/views'
import type { Json } from '../core/interfaces/items'
import { DOC_URL } from './fixtures/artifacts'
import { fakeConfig } from './fixtures/config-fs'
import type { GitHubRef, ItemRecord, ProcessRecord, Ref, RepoRecord, WebRef } from './fixtures/contracts'
import { fakeItems, promptRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { recordFromRef } from './fixtures/registry'

const gh = (n: number): GitHubRef => ({
  category: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type: 'issue',
})
const web = (url: string): WebRef => ({ category: 'web', url, label: url })
const rec = (ref: Ref): ItemRecord => recordFromRef(ref, { source: 'prompt', at: 10 })
const asJson = (list: ItemRecord[]) => list as unknown as Json
const argv0 = (calls: string[][], tool: string) => calls.filter(c => c[0] === tool)

test('with github off, start runs no gh command', async () => {
  const t = fakeItems({ off: ['github'] })
  const rt = await t.started()
  await rt.capture(promptRow('see issue #5 and https://docs.example/a'))
  expect(argv0(t.w.calls, 'gh')).toEqual([])
  expect(argv0(t.w.calls, 'acli').length).toBeGreaterThan(0) // jira is on: its probe ran
  expect(t.keys()).toEqual(['web:https://docs.example/a']) // the bare #5 needs gh to check it is open
})

test('with github off and no remote, the repo lookup runs no gh command', async () => {
  const off = fakeItems({ off: ['github'], remote: null })
  const rt = await off.started()
  await rt.capture(promptRow('see https://docs.example/a'))
  expect(argv0(off.w.calls, 'gh')).toEqual([])
  expect(off.keys()).toEqual(['web:https://docs.example/a'])
  const on = fakeItems({ remote: null }) // the control: gh repo view finds the repo
  await (await on.started()).capture(promptRow('see https://docs.example/a'))
  expect(on.w.calls.some(c => c[0] === 'gh' && c[1] === 'repo')).toBe(true)
})

test('with github on, the same start does run gh', async () => {
  const t = fakeItems()
  await t.started()
  expect(argv0(t.w.calls, 'gh').length).toBeGreaterThan(0)
})

test('with jira off, start runs no acli command', async () => {
  const t = fakeItems({ off: ['jira'] })
  const rt = await t.started()
  await rt.capture(promptRow('see https://acme.atlassian.net/browse/ISS-1'))
  expect(argv0(t.w.calls, 'acli')).toEqual([])
  expect(argv0(t.w.calls, 'gh').length).toBeGreaterThan(0) // github is on: its probe ran
  expect(t.keys()).toEqual([])
})

test('with github off a GitHub URL makes no item and no web link', async () => {
  const t = fakeItems({ off: ['github'] })
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/5'))
  expect(t.list()).toEqual([])
  expect(argv0(t.w.calls, 'gh')).toEqual([])
})

test('with web off a web URL makes no item; a GitHub URL still does', async () => {
  const t = fakeItems({ off: ['web'] })
  const rt = await t.started()
  await rt.capture(promptRow('see https://docs.example/a and https://github.com/cli/cli/pull/14640'))
  expect(t.keys()).toEqual(['gh:github.com/cli/cli#14640'])
})

test('with artifact off an artifact URL makes no item and no web link', async () => {
  const t = fakeItems({ off: ['artifact'] })
  const rt = await t.started()
  await rt.capture(promptRow(`see ${DOC_URL}`))
  expect(t.list()).toEqual([])
})

test('with file off a .md mention makes no item', async () => {
  const off = fakeItems({ off: ['file'] })
  off.w.files['/work/plan.md'] = '# plan'
  await (await off.started()).capture(promptRow('please read plan.md'))
  expect(off.list()).toEqual([])
  const on = fakeItems()
  on.w.files['/work/plan.md'] = '# plan'
  await (await on.started()).capture(promptRow('please read plan.md'))
  expect(on.keys()).toEqual(['file:/work/plan.md'])
})

test('start drops the records of a kind that is off, once', async () => {
  const t = fakeItems({ off: ['web'] })
  t.w.state.set('items', [rec(web('https://docs.example/a')), rec(gh(5))] as unknown as Json)
  await t.started()
  expect(t.w.stateSets.items).toBe(1)
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  await t.items.start(t.hostCtx)
  expect(t.w.stateSets.items).toBe(1) // nothing left to drop: no second write
})

test('start with every kind on leaves a warm list alone', async () => {
  const t = fakeItems()
  t.w.state.set('items', [rec(web('https://docs.example/a')), rec(gh(5))] as unknown as Json)
  await t.started()
  expect(t.w.stateSets.items).toBeUndefined()
})

test('replay, a resume load and a carry add no record of a kind that is off', async () => {
  const replayed = fakeItems({ off: ['web'] })
  await (await replayed.started()).replay(
    transcriptItems([
      {
        role: 'assistant',
        text: 'See [docs](https://docs.example/a) and https://github.com/cli/cli/pull/14640',
        toolUses: [],
      },
    ]),
  )
  expect(replayed.keys()).toEqual(['gh:github.com/cli/cli#14640'])

  const stored = [rec(web('https://docs.example/a')), rec(gh(5))]
  const loaded = fakeItems({ off: ['web'] })
  await (await loaded.started()).slot.restore(asJson(stored), 'load')
  expect(loaded.keys()).toEqual(['gh:github.com/acme/web#5'])

  const carried = fakeItems({ off: ['web'] })
  await (await carried.started()).slot.restore(asJson(stored), 'carry')
  expect(carried.keys()).toEqual(['gh:github.com/acme/web#5'])
  await carried.items.slot.restore(asJson([rec(web('https://docs.example/b'))]), 'carry') // only a dead kind: no write
  expect(carried.keys()).toEqual(['gh:github.com/acme/web#5'])
})

test('replay with file off does not look for .md files', async () => {
  const t = fakeItems({ off: ['file'] })
  t.w.files['/work/plan.md'] = '# plan'
  const stats: string[] = []
  const { stat } = t.w.ports.fs
  t.w.ports.fs.stat = (path, opts) => {
    stats.push(path)
    return stat(path, opts)
  }
  await (await t.started()).replay(transcriptItems([{ role: 'user', text: 'please read plan.md', toolUses: [] }]))
  expect(t.list()).toEqual([])
  expect(stats).toEqual([])
})

test('with jira off, a replay and a load ask acli for nothing', async () => {
  const t = fakeItems({ off: ['jira'] })
  const rt = await t.started()
  await rt.replay(
    transcriptItems([{ role: 'assistant', text: 'see https://acme.atlassian.net/browse/ISS-1', toolUses: [] }]),
  )
  await rt.slot.restore(asJson([rec(web('https://docs.example/a'))]), 'load')
  expect(argv0(t.w.calls, 'acli')).toEqual([])
  expect(t.keys()).toEqual(['web:https://docs.example/a'])
})

test('the pane sections leave out a tracker that is not live', async () => {
  const repo: RepoRecord = {
    key: 'remote:github.com/acme/sdk',
    name: 'acme/sdk',
    root: '/x/sdk',
    touchedBy: ['main'],
    firstSeen: 1,
    lastSeen: 1,
  }
  const proc: ProcessRecord = {
    id: 'p1',
    kind: 'background-task',
    name: 'sleep 9',
    state: 'running',
    firstSeen: 1,
    lastSeen: 1,
  }
  const sectionsWith = async (off: readonly string[]) => {
    const t = managerWorld({
      config: specs =>
        fakeConfig({ specs, file: { trackers: Object.fromEntries(off.map(id => [id, { enabled: false }])) } }),
    })
    await t.m.ensureStarted(t.w.ports)
    t.w.state.set('items', [rec(web('https://docs.example/a')), rec(gh(5))] as unknown as Json)
    t.w.state.set('repos', [repo] as unknown as Json)
    t.w.state.set('processes', [proc] as unknown as Json)
    t.w.stateSets = {}
    const sections = await t.m.paneData(t.w.ports, NO_VIEW)
    expect(t.w.stateSets).toEqual({}) // reads only
    return sections.map(section => section.id)
  }
  expect(await sectionsWith([])).toEqual(['github', 'repos', 'web', 'processes'])
  expect(await sectionsWith(['repos', 'web', 'processes', 'auto'])).toEqual(['github'])
})

test('the /track text leaves out a tracker that is off', async () => {
  const repo: RepoRecord = {
    key: 'remote:github.com/acme/sdk',
    name: 'acme/sdk',
    root: '/x/sdk',
    touchedBy: ['main'],
    firstSeen: 1,
    lastSeen: 1,
  }
  for (const off of [false, true]) {
    const t = managerWorld({
      config: specs => fakeConfig({ specs, file: off ? { trackers: { repos: { enabled: false } } } : {} }),
    })
    t.w.state.set('repos', [repo] as unknown as Json)
    const text = (await t.m.track(t.w.ports, '')).text ?? ''
    expect([off, text.includes('acme/sdk')]).toEqual([off, !off])
  }
})

test('the /track text with GitHub and Jira off shows no tool note', async () => {
  for (const off of [['github'], ['jira'], ['github', 'jira']]) {
    const t = managerWorld({
      config: specs =>
        fakeConfig({ specs, file: { trackers: Object.fromEntries(off.map(id => [id, { enabled: false }])) } }),
    })
    expect([off, (await t.m.track(t.w.ports, '')).text]).toEqual([off, 'No tracked items yet.'])
    expect(argv0(t.w.calls, 'gh').length + argv0(t.w.calls, 'acli').length).toBe(
      (off.includes('github') ? 0 : 1) + (off.includes('jira') ? 0 : 1), // one --version probe for each tool that is on
    )
  }
})

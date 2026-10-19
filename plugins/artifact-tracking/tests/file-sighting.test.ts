// File sightings on a small fake world: where a path lands, which sightings the ignore rule drops, and how a sighting
// joins the item list. Each case mirrors the kit test of the same subject in register.test.tsx. Plan: L3 Task 11.
import { expect, test } from 'claude-code/testing'
import type { Json, StoredItem } from '../core/interfaces/items'
import type { FsStat } from '../core/interfaces/ports'
import type { FileRecord, ItemRecord } from '../hooks/contracts'
import { addFiles, captureFileTouch, captureMentions, FileSight, withoutLoneViews } from '../trackers/file/sighting'

type World = {
  env: Record<string, string | undefined>
  settings: Json | undefined
  files: Record<string, string>
  cwd: string
  facts: Record<string, Json>
  list: ItemRecord[]
  dismissed: Set<string>
  statCalls: string[]
}

function world(over: Partial<World> = {}) {
  const w: World = {
    env: { HOME: '/home/me' },
    settings: undefined,
    files: {},
    cwd: '/work',
    facts: {},
    list: [],
    dismissed: new Set(),
    statCalls: [],
    ...over,
  }
  const sight = new FileSight({
    env: { get: async name => w.env[name], settings: async () => w.settings },
    fs: {
      stat: async (path, opts): Promise<FsStat | null> => {
        w.statCalls.push(path)
        const real = w.files[path]
        if (real === undefined) return null
        return {
          kind: 'file',
          size: 1,
          mtimeMs: 0,
          isLink: real !== path,
          ...(opts?.resolve ? { realPath: real } : {}),
        }
      },
    },
    session: { cwd: async () => w.cwd },
    facts: { read: <T extends Json>(name: string) => w.facts[name] as T | undefined },
    clock: { wall: () => 1000 },
  })
  const items = {
    update: async (change: (list: StoredItem[], dismissed: ReadonlySet<string>) => StoredItem[]) => {
      const cur = w.list as unknown as StoredItem[]
      const next = change(cur, w.dismissed)
      if (next === cur) return false
      w.list = next as unknown as ItemRecord[]
      return true
    },
  }
  return { w, sight, items }
}

const keys = (w: World) => w.list.map(r => r.key)

test('a relative path joins the session cwd, a ~ path joins HOME, a spelling with .. is folded', async () => {
  const { w, sight } = world()
  const ctx = await sight.ctxFor()
  expect((await sight.sighting(ctx, 'docs/../plan.md', 'created', false, { source: 'tool', at: 1 }))?.key).toBe(
    'file:/work/plan.md',
  )
  expect((await sight.sighting(ctx, '~/notes.md', 'edited', false, { source: 'tool', at: 1 }))?.key).toBe(
    'file:/home/me/notes.md',
  )
  w.env = {}
  const bare = await new FileSight({ ...sightDeps(w) }).ctxFor()
  expect(
    await new FileSight(sightDeps(w)).sighting(bare, '~/notes.md', 'edited', false, { source: 'tool', at: 1 }),
  ).toBeNull()
})

function sightDeps(w: World) {
  return {
    env: { get: async (name: string) => w.env[name], settings: async () => w.settings },
    fs: { stat: async () => null },
    session: { cwd: async () => w.cwd },
    facts: { read: <T extends Json>(name: string) => w.facts[name] as T | undefined },
    clock: { wall: () => 1 },
  }
}

test('two spellings that land on one real path are one row, labelled as first spelled', async () => {
  const { w, sight, items } = world({ files: { '/work/link.md': '/work/real.md', '/work/real.md': '/work/real.md' } })
  await captureFileTouch(sight, items, { spelled: 'link.md', kind: 'created' }, undefined)
  await captureFileTouch(sight, items, { spelled: 'real.md', kind: 'edited' }, undefined)
  expect(keys(w)).toEqual(['file:/work/real.md'])
  expect((w.list[0] as FileRecord).label).toBe('/work/link.md')
})

test('the environment is read once for the load: HOME, CLAUDE_CONFIG_DIR and the memory setting', async () => {
  let reads = 0
  const { w, sight } = world({
    env: { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' },
    settings: { autoMemoryDirectory: '~/mem' },
  })
  const get = w.env
  w.env = new Proxy(get, {
    get: (t, k) => {
      reads++
      return t[k as string]
    },
  })
  const a = await sight.ctxFor()
  const b = await sight.ctxFor()
  expect(a).toMatchObject({ home: '/home/me', configDir: '/cfg', memoryDir: '/home/me/mem' })
  expect(b).toEqual(a)
  expect(reads).toBe(2) // HOME and CLAUDE_CONFIG_DIR, once
})

test('without CLAUDE_CONFIG_DIR the config dir is under HOME, and an env that throws leaves the parts out', async () => {
  const { sight } = world()
  expect(await sight.ctxFor()).toMatchObject({ configDir: '/home/me/.claude' })
  const failing = new FileSight({
    env: { get: () => Promise.reject(new Error('no')), settings: () => Promise.reject(new Error('no')) },
    fs: { stat: async () => null },
    session: { cwd: async () => '/w' },
    facts: { read: () => undefined },
    clock: { wall: () => 1 },
  })
  expect(await failing.ctxFor()).toEqual({ cwd: '/w' })
})

test('the ignore rule: .git, node_modules, auto-memory and the scratchpad give no row; plans and CLAUDE.md stay', async () => {
  const { w, sight, items } = world({ facts: { 'auto.root': { cwd: '/work', at: 0 } } })
  for (const p of [
    '/work/.git/info.md',
    '/work/node_modules/x/a.md',
    '/home/me/.claude/projects/p/memory/m.md',
    '/tmp/claude-501/slug/sess/scratchpad/s.md',
    '/work/docs/plan.md',
    '/work/CLAUDE.md',
  ])
    await captureFileTouch(sight, items, { spelled: p, kind: 'created' }, undefined)
  expect(keys(w).sort()).toEqual(['file:/work/CLAUDE.md', 'file:/work/docs/plan.md'])
})

test('a subagent path joins its spawn cwd from the auto.agents fact, else the session cwd', async () => {
  const { w, sight, items } = world({
    facts: { 'auto.agents': [{ id: 'agent-1', kind: 'workflow', label: 'x', cwd: '/wt' }] as unknown as Json },
  })
  await captureFileTouch(sight, items, { spelled: 'a.md', kind: 'created' }, 'agent-1')
  await captureFileTouch(sight, items, { spelled: 'b.md', kind: 'created' }, 'agent-2')
  expect(keys(w).sort()).toEqual(['file:/work/b.md', 'file:/wt/a.md'])
  expect((w.list.find(r => r.key === 'file:/wt/a.md') as FileRecord).bySubagent).toBe(true)
})

test('a Read counts a view on a tracked row and never adds a row', async () => {
  const { w, sight, items } = world()
  await captureFileTouch(sight, items, { spelled: 'a.md', kind: 'viewed' }, undefined)
  expect(keys(w)).toEqual([])
  await captureFileTouch(sight, items, { spelled: 'a.md', kind: 'created' }, undefined)
  await captureFileTouch(sight, items, { spelled: 'a.md', kind: 'viewed' }, undefined)
  expect((w.list[0] as FileRecord).views).toBe(1)
})

test('a dismissed key stays out; a list that would not change is not written', async () => {
  const { w, sight, items } = world()
  w.dismissed.add('file:/work/a.md')
  await captureFileTouch(sight, items, { spelled: 'a.md', kind: 'created' }, undefined)
  expect(keys(w)).toEqual([])
  const list = w.list
  await addFiles(items, [])
  expect(w.list).toBe(list)
})

test('a mention adds a row only when the file is there; most texts name no file and read nothing', async () => {
  const { w, sight, items } = world({ files: { '/work/README.md': '/work/README.md' } })
  await captureMentions(sight, items, 'nothing to see', 'prompt')
  expect(w.statCalls).toEqual([])
  await captureMentions(sight, items, 'read README.md and MISSING.md', 'prompt')
  expect(keys(w)).toEqual(['file:/work/README.md'])
  expect((w.list[0] as FileRecord).mentions).toBe(1)
  await captureMentions(sight, items, 'only MISSING.md here', 'prompt')
  expect(keys(w)).toEqual(['file:/work/README.md'])
})

test('withoutLoneViews keeps a view only for a key an earlier sighting tracks', () => {
  const rec = (key: string, views: number) => ({ key, views }) as unknown as FileRecord
  const known = [{ key: 'file:/a.md' }] as unknown as ItemRecord[]
  expect(
    withoutLoneViews(known, [
      rec('file:/a.md', 1),
      rec('file:/b.md', 1),
      rec('file:/c.md', 0),
      rec('file:/c.md', 1),
    ]).map(r => r.key),
  ).toEqual(['file:/a.md', 'file:/c.md', 'file:/c.md'])
})

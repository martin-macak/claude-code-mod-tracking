// The file tracker on fakePorts, through the LifecycleManager: Write, Edit and Read results track Markdown files
// (issue #28). Each case mirrors the kit test of the same subject in register.test.tsx. The facts `auto.root` and
// `auto.agents` stand in for the auto tracker. Plan: L3 Task 12.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { FileRecord } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { fileConfig, fileTracker } from '../trackers/file'
import { managerWorld } from './fixtures/manager'

const created = (filePath: string) => ({
  type: 'create',
  filePath,
  content: '# x',
  structuredPatch: [],
  originalFile: null,
  userModified: false,
})
const updated = (filePath: string) => ({ ...created(filePath), type: 'update', originalFile: '# x' })
const edited = (filePath: string) => ({
  filePath,
  oldString: 'a',
  newString: 'b',
  originalFile: 'a',
  structuredPatch: [],
  userModified: false,
  replaceAll: false,
})
const viewed = (filePath: string) => ({
  type: 'text',
  file: { filePath, content: '# x', numLines: 1, startLine: 1, totalLines: 1 },
})

function world(o: { cwd?: string; env?: Record<string, string>; settings?: Json } = {}) {
  const w = managerWorld({
    trackers: () => [fileTracker()],
    fake: { session: { cwd: o.cwd ?? '/work' }, env: o.env ?? {}, settings: o.settings as never },
  })
  w.m.facts.publish('auto.root', { cwd: o.cwd ?? '/work', at: 0, top: o.cwd ?? '/work' })
  /** One finished tool call with `result` as the reply. */
  const tool = (
    name: 'Write' | 'Edit' | 'Read',
    result: unknown,
    extra: { agentId?: string; isError?: boolean } = {},
  ) =>
    w.call(
      name,
      { file_path: '/ignored' },
      { result, ...(extra.isError ? { isError: true } : {}) },
      extra.agentId !== undefined ? { agentId: extra.agentId } : {},
    )
  /** Each row as its label (the absolute path as Claude spelled it) and its activity counts. */
  const files = () =>
    (w.items() as unknown as FileRecord[]).map(r => ({
      label: r.label,
      created: r.created,
      edits: r.edits,
      views: r.views,
    }))
  return { ...w, tool, files }
}

test('the tracker takes order 70 and hears Write, Edit and Read; it keeps no data', () => {
  const t = fileTracker()
  expect([t.id, t.order]).toEqual(['file', 70])
  expect(Object.keys(t.events?.toolCall ?? {}).sort()).toEqual(['Edit', 'Read', 'Write'])
  expect(t.data).toBeUndefined()
})

test('a Write create, an update and an Edit are counted; only .md paths count, in any case', async () => {
  const t = world()
  await t.tool('Write', created('/work/docs/plan.md'))
  expect(t.files()).toEqual([{ label: '/work/docs/plan.md', created: true, edits: 0, views: 0 }])
  await t.tool('Write', updated('/work/docs/plan.md'))
  await t.tool('Edit', edited('/work/docs/plan.md'))
  expect(t.files()[0]).toMatchObject({ created: true, edits: 2 })
  for (const p of ['/work/src/a.ts', '/work/docs/plan.md.bak', '/work/README']) await t.tool('Write', created(p))
  await t.tool('Edit', edited('/work/docs/LOUD.MD'))
  expect(t.keys()).toEqual(['file:/work/docs/plan.md', 'file:/work/docs/LOUD.MD'])
})

test('a failed, denied or staged call adds nothing', async () => {
  const t = world()
  await t.tool('Write', 'Error: Claude requested permissions to write to /work/d.md', { isError: true })
  await t.tool('Write', created('/work/d.md'), { isError: true })
  await t.tool('Edit', 'Error: String to replace not found in file.', { isError: true })
  await t.tool('Write', { ...created('/work/s.md'), staged: true })
  await t.tool('Edit', { ...edited('/work/s.md'), staged: true })
  await t.call('Write', { file_path: '/work/x.md' }, { deny: 'blocked by a hook' })
  expect(t.keys()).toEqual([])
})

test('a relative path joins the session cwd; .. and // spellings are one row', async () => {
  const t = world()
  await t.tool('Write', created('notes.md'))
  await t.tool('Write', updated('/work/docs/../notes.md'))
  await t.tool('Edit', edited('/work//./notes.md'))
  expect(t.files()).toEqual([{ label: '/work/notes.md', created: true, edits: 2, views: 0 }])
})

test('two spellings that land on one real path are one row, labelled as first spelled', async () => {
  const t = world()
  t.w.files['/tmp/w/a.md'] = '#'
  t.w.files['/private/tmp/w/a.md'] = '#'
  const realPath = t.w.ports.fs.stat
  t.w.ports.fs.stat = async (path, opts) => {
    const st = await realPath(path, opts)
    return st && opts?.resolve ? { ...st, realPath: '/private/tmp/w/a.md' } : st
  }
  await t.tool('Write', created('/tmp/w/a.md'))
  await t.tool('Edit', edited('/private/tmp/w/a.md'))
  expect(t.files()).toEqual([{ label: '/tmp/w/a.md', created: true, edits: 1, views: 0 }])
  expect(t.keys()).toEqual(['file:/private/tmp/w/a.md'])
})

test('.git, node_modules, auto-memory and the scratchpad are ignored; plans and CLAUDE.md stay', async () => {
  const t = world({ env: { HOME: '/home/u' } })
  const pad = '/private/tmp/claude-501/-work/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/scratchpad'
  for (const p of [
    '/work/.git/notes.md',
    '/work/NODE_MODULES/x/README.md',
    '/home/u/.claude/projects/-work/memory/MEMORY.md',
    `${pad}/notes.md`,
  ])
    await t.tool('Write', created(p))
  expect(t.keys()).toEqual([])
  for (const p of ['/home/u/.claude/plans/p.md', '/work/CLAUDE.md', '/work/docs/scratchpad/x.md'])
    await t.tool('Write', created(p))
  expect(t.files().map(f => f.label)).toEqual([
    '/home/u/.claude/plans/p.md',
    '/work/CLAUDE.md',
    '/work/docs/scratchpad/x.md',
  ])
})

test('CLAUDE_CONFIG_DIR and the autoMemoryDirectory setting move the memory rule; ~ joins HOME', async () => {
  const dir = world({ env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' } })
  await dir.tool('Write', created('/cfg/projects/x/memory/a.md'))
  expect(dir.keys()).toEqual([])
  await dir.tool('Write', created('/home/u/.claude/projects/x/memory/b.md'))
  expect(dir.files().map(f => f.label)).toEqual(['/home/u/.claude/projects/x/memory/b.md'])
  const mem = world({ env: { HOME: '/home/u' }, settings: { autoMemoryDirectory: '~/notes-mem' } })
  await mem.tool('Write', created('/home/u/notes-mem/-work/MEMORY.md'))
  expect(mem.keys()).toEqual([])
  await mem.tool('Write', created('/home/u/notes/a.md'))
  expect(mem.files().map(f => f.label)).toEqual(['/home/u/notes/a.md'])
})

test('a Read alone never adds a row; it counts a view on a tracked row', async () => {
  const t = world()
  await t.tool('Read', viewed('/work/README.md'))
  expect(t.keys()).toEqual([])
  await t.tool('Write', created('/work/docs/plan.md'))
  await t.tool('Read', viewed('/work/docs/plan.md'))
  await t.tool('Read', viewed('docs/plan.md'))
  expect(t.files()).toEqual([{ label: '/work/docs/plan.md', created: true, edits: 0, views: 2 }])
})

test('a subagent path joins its spawn cwd from the auto.agents fact; the main loop joins the session cwd', async () => {
  const t = world()
  t.m.facts.publish('auto.agents', [{ id: 'agent-1', kind: 'subagent', label: 'x', spawnedAt: 0, cwd: '/other' }])
  await t.tool('Write', created('notes.md'), { agentId: 'agent-1' })
  await t.tool('Write', created('notes.md'))
  expect(t.keys()).toEqual(['file:/other/notes.md', 'file:/work/notes.md'])
  expect(t.files().map(f => f.label)).toEqual(['/other/notes.md', '/work/notes.md'])
})

test('each dispatch reads the session cwd of its own ports, not the ports of the first hook of the load', async () => {
  const t = world()
  await t.tool('Write', created('first.md')) // the first hook builds the load: the cwd is /work
  const other = { ...t.w.ports, session: { ...t.w.ports.session, cwd: async () => '/agent-cwd' } }
  await t.m.toolCall(other, { tool: 'Write', input: { tool: 'Write' }, result: { result: created('second.md') } })
  expect(t.keys()).toEqual(['file:/work/first.md', 'file:/agent-cwd/second.md'])
})

test('a dismissed row stays out after a later write, edit or read', async () => {
  const t = world()
  await t.tool('Write', created('/work/docs/plan.md'))
  await t.m.dismiss(t.w.ports, ['file:/work/docs/plan.md'])
  expect(t.keys()).toEqual([])
  await t.tool('Write', updated('/work/docs/plan.md'))
  await t.tool('Edit', edited('/work/docs/plan.md'))
  await t.tool('Read', viewed('/work/docs/plan.md'))
  expect(t.keys()).toEqual([])
})

test('a refused item write does not reject the dispatch', async () => {
  const t = world()
  const fail = async () => {
    throw new Error('denied')
  }
  t.w.ports.state.items.update = fail
  await t.tool('Write', created('/work/docs/plan.md')) // the bus isolates the handler: this resolves
  expect(t.keys()).toEqual([])
  expect(t.w.logs.some(l => l.includes('toolCall failed in file'))).toBe(true)
})

test('config: enabled is a flag and maxMentionsPerRow a number in range; bad values warn and keep the default', () => {
  const list: string[] = []
  const warn = (p: string) => void list.push(p)
  expect(fileConfig.defaults).toEqual({ enabled: true, maxMentionsPerRow: LIMITS.maxMentionsPerRow })
  expect(Object.isFrozen(fileConfig.defaults)).toBe(true)
  const good = fileConfig.normalise({ enabled: false, maxMentionsPerRow: 5.4, extra: 1 }, fileConfig.defaults, warn)
  expect(good).toEqual({ enabled: false, maxMentionsPerRow: 5, extra: 1 })
  expect(list).toEqual([])
  const bad = fileConfig.normalise({ enabled: 1, maxMentionsPerRow: 0 }, fileConfig.defaults, warn)
  expect(bad).toEqual(fileConfig.defaults)
  expect(list.length).toBe(2)
})

// The file tracker on fakePorts, through the LifecycleManager: Read, Write, Edit and NotebookEdit results and the
// `bashEditDiff` of a Bash call track files of any type (issues #28 and #57). Each case mirrors the kit test of the same
// subject in register.test.tsx. The facts `auto.root` and `auto.agents` stand in for the auto tracker. Plan: L3 Task 12.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { RowEvent } from '../core/interfaces/events'
import type { Json } from '../core/interfaces/items'
import { viewGroups } from '../core/lib/grouping'
import { listText } from '../hooks/pane-text'
import { fileConfig, fileKind, fileTracker } from '../trackers/file'
import { fakeConfig } from './fixtures/config-fs'
import type { FileRecord } from './fixtures/contracts'
import { LIMITS } from './fixtures/limits'
import { managerWorld } from './fixtures/manager'

declare function setTimeout(fn: () => void, ms: number): unknown

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
/** The answer of a second Read of a file that did not change (issue #245). */
const unchanged = (filePath: string) => ({ type: 'file_unchanged', file: { filePath } })
/** The answer of a Read of an image: no path in the result (probe P1 of the #57 study). */
const image = { type: 'image', file: { base64: '...', type: 'image/png', originalSize: 70 } }
const notebook = (notebook_path: string, error = '') => ({
  cell_type: 'code',
  edit_mode: 'replace',
  error,
  notebook_path,
})
/** One hunk as the typings give it (`bashEditDiff.files[].hunks`). */
const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
/** The answer of a Bash call that the engine recorded (`bashEditDiff`). */
const bashDiff = (o: { edited?: string[]; created?: string[]; deleted?: string[]; moreChanged?: string[] }) => {
  const files = [
    ...(o.edited ?? []).map(filePath => ({ filePath, hunks: [hunk] })),
    ...(o.created ?? []).map(filePath => ({ filePath, hunks: [], created: true })),
    ...(o.deleted ?? []).map(filePath => ({ filePath, hunks: [hunk], deleted: true })),
  ]
  const changedFiles = [...files.map(f => f.filePath), ...(o.moreChanged ?? [])]
  return { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files, moreFiles: 0, changedFiles } }
}

function world(
  o: { cwd?: string; env?: Record<string, string>; settings?: Json; slice?: Record<string, Json>; global?: Json } = {},
) {
  const w = managerWorld({
    trackers: () => [fileTracker()],
    fake: { session: { cwd: o.cwd ?? '/work' }, env: o.env ?? {}, settings: o.settings as never },
    config: specs =>
      fakeConfig({ specs, file: { version: 1, global: o.global ?? {}, trackers: { file: o.slice ?? {} } } as never }),
  })
  w.m.facts.publish('auto.root', { cwd: o.cwd ?? '/work', at: 0, top: o.cwd ?? '/work' })
  /** One finished tool call with `result` as the reply. */
  const tool = (
    name: 'Write' | 'Edit' | 'Read' | 'NotebookEdit' | 'Bash',
    result: unknown,
    extra: { agentId?: string; isError?: boolean; input?: Record<string, unknown> } = {},
  ) =>
    w.call(
      name,
      extra.input ?? { file_path: '/ignored' },
      { result, ...(extra.isError ? { isError: true } : {}) },
      extra.agentId !== undefined ? { agentId: extra.agentId } : {},
    )
  /** Each row as its label (the absolute path as Claude spelled it) and its activity counts. */
  const files = () =>
    (w.items() as unknown as FileRecord[])
      .filter(r => r.category === 'file')
      .map(r => ({
        label: r.label,
        created: r.created,
        edits: r.edits,
        views: r.views,
      }))
  /** A row of text from Claude, as the item host captures it. */
  const say = (text: string) =>
    w.m.row(w.w.ports, { door: 'response', origin: 'unclassified', isMeta: false, hasMessage: true, text } as RowEvent)
  const rec = (path: string) => (w.items() as unknown as FileRecord[]).find(r => r.key === `file:${path}`)
  return { ...w, tool, files, say, rec }
}

test('the tracker takes order 70; its kind hears the file tools and Bash; it keeps no data and has the file tool', () => {
  const t = fileTracker()
  expect([t.id, t.order]).toEqual(['file', 70])
  expect(Object.keys(fileKind.fromTool ?? {}).sort()).toEqual(['Bash', 'Edit', 'NotebookEdit', 'Read', 'Write'])
  expect(t.kinds).toEqual([fileKind])
  expect(t.tools?.map(x => x.id)).toEqual(['file'])
  // The one job of the tracker is the type lookup: a call of a file tool starts it, and so does the tick.
  expect(Object.keys(t.events?.toolCall ?? {}).sort()).toEqual(['Bash', 'Edit', 'NotebookEdit', 'Read', 'Write'])
  expect(typeof t.events?.tick?.run).toBe('function')
  expect(t.data).toBeUndefined()
  // #57 L1 adds no key, action or command: `v` and `d` come with L2 and L3.
  expect(t.keys).toBeUndefined()
  expect(t.actions).toBeUndefined()
  expect(t.commands).toBeUndefined()
})

test('a Write create, an update and an Edit are counted, for a file of any type', async () => {
  const t = world()
  await t.tool('Write', created('/work/docs/plan.md'))
  expect(t.files()).toEqual([{ label: '/work/docs/plan.md', created: true, edits: 0, views: 0 }])
  await t.tool('Write', updated('/work/docs/plan.md'))
  await t.tool('Edit', edited('/work/docs/plan.md'))
  expect(t.files()[0]).toMatchObject({ created: true, edits: 2 })
  for (const p of ['/work/src/a.ts', '/work/docs/plan.md.bak', '/work/README']) await t.tool('Write', created(p))
  await t.tool('Edit', edited('/work/docs/LOUD.MD'))
  expect(t.keys()).toEqual([
    'file:/work/docs/plan.md',
    'file:/work/src/a.ts',
    'file:/work/docs/plan.md.bak',
    'file:/work/README',
    'file:/work/docs/LOUD.MD',
  ])
})

test('scope md goes back to the .md files of issue #28: other paths add no row, from a tool or from Bash', async () => {
  const t = world({ slice: { scope: 'md' } })
  await t.tool('Write', created('/work/src/a.ts'))
  await t.tool('Read', viewed('/work/src/a.ts'))
  await t.tool('Bash', bashDiff({ created: ['/work/out.txt', '/work/out.md'] }))
  await t.tool('Write', created('/work/docs/LOUD.MD'))
  expect(t.keys()).toEqual(['file:/work/out.md', 'file:/work/docs/LOUD.MD'])
  // A Read alone still adds a row: the scope only picks the files (issue #57).
  await t.tool('Read', viewed('/work/README.md'))
  expect(t.rec('/work/README.md')).toMatchObject({ views: 1 })
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

test('.git, node_modules, auto-memory and the scratchpad are ignored, whatever the type; plans and CLAUDE.md stay', async () => {
  const t = world({ env: { HOME: '/home/u' } })
  const pad = '/private/tmp/claude-501/-work/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/scratchpad'
  for (const p of [
    '/work/.git/notes.md',
    '/work/NODE_MODULES/x/README.md',
    '/home/u/.claude/projects/-work/memory/MEMORY.md',
    `${pad}/notes.md`,
    '/work/.git/config',
    '/work/node_modules/pkg/index.js',
    '/home/u/.claude/projects/-work/memory/state.json',
    `${pad}/out.txt`,
  ])
    await t.tool('Write', created(p))
  await t.tool('Read', viewed('/work/node_modules/pkg/index.js'))
  expect(t.keys()).toEqual([])
  for (const p of ['/home/u/.claude/plans/p.md', '/work/CLAUDE.md', '/work/docs/scratchpad/x.md', '/work/src/a.ts'])
    await t.tool('Write', created(p))
  expect(t.files().map(f => f.label)).toEqual([
    '/home/u/.claude/plans/p.md',
    '/work/CLAUDE.md',
    '/work/docs/scratchpad/x.md',
    '/work/src/a.ts',
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

test('a Read alone adds a row, and it counts a view on a tracked row', async () => {
  const t = world()
  await t.tool('Read', viewed('/work/README.md'))
  expect(t.files()).toEqual([{ label: '/work/README.md', created: false, edits: 0, views: 1 }])
  expect(t.rec('/work/README.md')?.reasons.strongest).toBe('read')
  await t.tool('Write', created('/work/docs/plan.md'))
  await t.tool('Read', viewed('/work/docs/plan.md'))
  await t.tool('Read', viewed('docs/plan.md'))
  expect(t.files()[1]).toEqual({ label: '/work/docs/plan.md', created: true, edits: 0, views: 2 })
})

test('a Read of an unchanged file counts a view as a Read of text does, and a lone one adds a row', async () => {
  const t = world()
  await t.tool('Read', unchanged('/work/README.md'))
  expect(t.files()).toEqual([{ label: '/work/README.md', created: false, edits: 0, views: 1 }])
  await t.tool('Write', created('/work/docs/plan.md'))
  await t.tool('Read', viewed('/work/docs/plan.md'))
  await t.tool('Read', unchanged('/work/docs/plan.md'))
  await t.tool('Read', unchanged('docs/plan.md'))
  await t.tool('Read', unchanged('/work/docs/plan.md'), { isError: true })
  expect(t.files()[1]).toEqual({ label: '/work/docs/plan.md', created: true, edits: 0, views: 3 })
})

test('a Read of a notebook, a PDF or an image adds a row; an image has its path in the input only', async () => {
  const t = world()
  await t.tool('Read', { type: 'notebook', file: { filePath: '/work/nb.ipynb', cells: [] } })
  await t.tool('Read', { type: 'pdf', file: { filePath: '/work/doc.pdf', base64: '', originalSize: 193 } })
  await t.tool('Read', image, { input: { file_path: '/work/img.png' } })
  await t.tool('Read', image, { input: { notebook_path: 'no file_path here' } })
  await t.tool('Read', 'Error: This tool cannot read binary files.', {
    isError: true,
    input: { file_path: '/work/x.bin' },
  })
  expect(t.keys()).toEqual(['file:/work/nb.ipynb', 'file:/work/doc.pdf', 'file:/work/img.png'])
})

test('a NotebookEdit counts as an edit; a failed one adds nothing', async () => {
  const t = world()
  await t.tool('NotebookEdit', notebook('/work/nb.ipynb'), {
    input: { notebook_path: '/work/nb.ipynb', cell_id: 'c1' },
  })
  await t.tool('NotebookEdit', notebook('/work/nb.ipynb'))
  expect(t.files()).toEqual([{ label: '/work/nb.ipynb', created: false, edits: 2, views: 0 }])
  await t.tool('NotebookEdit', 'Error: Cell with ID "nope" not found in notebook.', { isError: true })
  await t.tool('NotebookEdit', notebook('/work/other.ipynb', 'Cell not found'))
  expect(t.keys()).toEqual(['file:/work/nb.ipynb'])
})

// ---------------------------------------------------------------- Bash (issue #57, R4a)

test('Bash: the files of bashEditDiff are edited, created or deleted; a path of changedFiles alone is edited', async () => {
  const t = world()
  await t.tool(
    'Bash',
    bashDiff({
      edited: ['/work/src/a.ts'],
      created: ['/work/out.txt'],
      deleted: ['/work/old.md'],
      moreChanged: ['/work/b.ts'],
    }),
    { input: { command: 'edit a.ts; make out.txt; remove old.md' } },
  )
  expect(t.rec('/work/src/a.ts')).toMatchObject({ edits: 1, created: false })
  expect(t.rec('/work/out.txt')).toMatchObject({ created: true, edits: 0 })
  expect(t.rec('/work/old.md')).toMatchObject({ deleted: true, edits: 0, created: false })
  expect(t.rec('/work/b.ts')).toMatchObject({ edits: 1 })
  expect(t.rec('/work/old.md')?.reasons.strongest).toBe('deleted')
})

test('Bash: a delete marks the row, and a later Write of the file clears the mark', async () => {
  const t = world()
  await t.tool('Write', created('/work/a.ts'))
  await t.tool('Bash', bashDiff({ deleted: ['/work/a.ts'] }))
  expect(t.rec('/work/a.ts')).toMatchObject({ deleted: true, created: true })
  await t.w.clock.advance(5)
  await t.tool('Write', created('/work/a.ts'))
  expect(t.rec('/work/a.ts')?.deleted).toBeUndefined()
  expect(t.rec('/work/a.ts')?.reasons.all).not.toContain('deleted')
})

test('Bash: a delete of a file that landed on a real path marks that row, not a second one', async () => {
  const t = world({ cwd: '/tmp/w' })
  t.w.files['/tmp/w/a.md'] = '#'
  const stat = t.w.ports.fs.stat
  t.w.ports.fs.stat = async (path, opts) => {
    if (opts?.resolve && path === '/tmp/w') return { kind: 'dir', realPath: '/private/tmp/w' } as never
    const st = await stat(path, opts)
    return st && opts?.resolve && path === '/tmp/w/a.md' ? { ...st, realPath: '/private/tmp/w/a.md' } : st
  }
  await t.tool('Write', created('/tmp/w/a.md'))
  delete t.w.files['/tmp/w/a.md']
  await t.tool('Bash', bashDiff({ deleted: ['/tmp/w/a.md'] }))
  expect(t.keys()).toEqual(['file:/private/tmp/w/a.md'])
  expect(t.rec('/private/tmp/w/a.md')).toMatchObject({ created: true, deleted: true })
})

test('Bash: the files of one call are looked at together, and the claims keep the order of the call', async () => {
  const t = world()
  const names = ['/work/a.ts', '/work/b.ts', '/work/c.ts']
  for (const n of names) t.w.files[n] = 'x'
  const stat = t.w.ports.fs.stat
  const asked: string[] = []
  let release!: () => void
  const held = new Promise<void>(go => (release = go))
  let allAsked!: () => void
  const everyStat = new Promise<void>(go => (allAsked = go))
  t.w.ports.fs.stat = async (path, opts) => {
    if (names.includes(path)) {
      asked.push(path)
      if (asked.length === names.length) allAsked()
      await held // the first stat waits for the others: a loop that awaits each stat in turn never gets there
    }
    return stat(path, opts)
  }
  const call = t.tool('Bash', bashDiff({ edited: names }))
  // The hang guard only ends a run that never gets there; the test does not wait for it when the stats run together.
  const guard = new Promise<string>(go => setTimeout(() => go('stats were awaited one after another'), 2000))
  expect(await Promise.race([everyStat.then(() => 'together'), guard])).toBe('together')
  release()
  await call
  expect(t.keys()).toEqual(names.map(n => `file:${n}`))
})

test('Bash: no bashEditDiff, a skipped diff, a denied call and a staged call add nothing', async () => {
  const t = world()
  await t.tool('Bash', { stdout: 'x', stderr: '', interrupted: false }, { input: { command: 'cat a.ts' } })
  await t.tool('Bash', { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, skipped: true } })
  await t.call('Bash', { command: 'remove a' }, { deny: 'blocked by a hook' })
  await t.call('Bash', { command: 'remove a' }, { result: { ...bashDiff({ deleted: ['/work/a'] }), staged: true } })
  expect(t.keys()).toEqual([])
})

test('Bash: the ignored paths apply, and a subagent Bash call says subagent', async () => {
  const t = world()
  t.m.facts.publish('auto.agents', [{ id: 'agent-1', kind: 'subagent', label: 'x', spawnedAt: 0, cwd: '/work' }])
  await t.tool('Bash', bashDiff({ created: ['/work/node_modules/x/a.js', '/work/.git/HEAD', '/work/keep.txt'] }), {
    agentId: 'agent-1',
  })
  expect(t.keys()).toEqual(['file:/work/keep.txt'])
  expect((t.rec('/work/keep.txt') as FileRecord).bySubagent).toBe(true)
})

test('Bash: bashEdits false counts nothing from Bash, and the file tools go on', async () => {
  const t = world({ slice: { bashEdits: false } })
  await t.tool('Bash', bashDiff({ created: ['/work/out.txt'] }))
  await t.tool('Write', created('/work/a.ts'))
  expect(t.keys()).toEqual(['file:/work/a.ts'])
})

test('a failed call still counts what the engine reports for Bash, and nothing for a file tool', async () => {
  const t = world()
  await t.tool('Bash', bashDiff({ edited: ['/work/a.ts'] }), { isError: true })
  await t.tool('Write', created('/work/b.ts'), { isError: true })
  expect(t.keys()).toEqual(['file:/work/a.ts'])
})

// ---------------------------------------------------------------- mentions of any path (issue #57, R2)

test('a reply that names an existing file of any type adds a mentioned row; a missing file and prose add none', async () => {
  const t = world()
  t.w.files['/work/src/a.ts'] = 'x'
  t.w.files['/work/Makefile'] = 'x'
  await t.say('Look at src/a.ts and Makefile, then src/missing.ts, e.g. acme/web#5 and and/or.')
  expect(t.keys().sort()).toEqual(['file:/work/Makefile', 'file:/work/src/a.ts'])
  expect(t.rec('/work/src/a.ts')).toMatchObject({ mentions: 1, views: 0, edits: 0 })
  expect(t.rec('/work/src/a.ts')?.reasons.strongest).toBe('mentioned')
})

test('a mention costs one stat, also for a file that is not there; only a Bash delete looks at the folder', async () => {
  const t = world()
  const stat = t.w.ports.fs.stat
  const statted: string[] = []
  t.w.ports.fs.stat = async (path, opts) => {
    statted.push(path)
    return stat(path, opts)
  }
  await t.say('Look at src/missing.ts.')
  expect(statted).toEqual(['/work/src/missing.ts'])
  statted.length = 0
  await t.tool('Bash', bashDiff({ deleted: ['/work/src/gone.ts'] }))
  expect(statted).toEqual(['/work/src/gone.ts', '/work/src'])
})

test('mentions: scope md reads .md paths only, and maxMentionsPerRow 0 reads none', async () => {
  const md = world({ slice: { scope: 'md' } })
  md.w.files['/work/src/a.ts'] = 'x'
  md.w.files['/work/README.md'] = 'x'
  await md.say('see src/a.ts and README.md')
  expect(md.keys()).toEqual(['file:/work/README.md'])
  const off = world({ slice: { maxMentionsPerRow: 0 } })
  off.w.files['/work/README.md'] = 'x'
  await off.say('see README.md')
  expect(off.keys()).toEqual([])
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

test('a dismissed file of any type stays out after a later write, read, Bash change or mention', async () => {
  const t = world()
  t.w.files['/work/src/a.ts'] = 'x'
  await t.tool('Read', viewed('/work/src/a.ts'))
  await t.m.dismiss(t.w.ports, ['file:/work/src/a.ts'])
  expect(t.keys()).toEqual([])
  await t.tool('Write', updated('/work/src/a.ts'))
  await t.tool('Read', viewed('/work/src/a.ts'))
  await t.tool('Bash', bashDiff({ edited: ['/work/src/a.ts'] }))
  await t.say('see src/a.ts')
  expect(t.keys()).toEqual([])
})

test('a refused item write does not reject the dispatch', async () => {
  const t = world()
  const fail = async () => {
    throw new Error('denied')
  }
  t.w.ports.state.items.update = fail
  await t.tool('Write', created('/work/docs/plan.md')) // the item host isolates the kind: this resolves
  expect(t.keys()).toEqual([])
  expect(t.w.logs.some(l => l.includes('toolCall failed in file'))).toBe(true) // the item host isolates each kind
})

test('config: the keys of the file tracker and their defaults; bad values warn and fall back', () => {
  const list: string[] = []
  const warn = (p: string) => void list.push(p)
  const defaults = {
    enabled: true,
    scope: 'all',
    maxMentionsPerRow: LIMITS.maxMentionsPerRow,
    maxFiles: 300,
    bashEdits: true,
    mime: true,
    prompt: { enabled: false, maxItems: 20 },
  }
  expect(fileConfig.defaults).toEqual(defaults)
  expect(Object.isFrozen(fileConfig.defaults)).toBe(true)
  const good = fileConfig.normalise(
    { enabled: false, scope: 'md', maxMentionsPerRow: 5, maxFiles: 80, bashEdits: false, mime: false, extra: 1 },
    fileConfig.defaults,
    warn,
  )
  expect(good).toEqual({
    ...defaults,
    enabled: false,
    scope: 'md',
    maxMentionsPerRow: 5,
    maxFiles: 80,
    bashEdits: false,
    mime: false,
    extra: 1,
  })
  expect(list).toEqual(['extra: unknown key. The mod keeps it and ignores it.'])
  // 0 is valid (read no mention). A decimal is no whole number: the default.
  expect(fileConfig.normalise({ maxMentionsPerRow: 0 }, fileConfig.defaults, warn).maxMentionsPerRow).toBe(0)
  expect(list).toHaveLength(1)
  const bad = fileConfig.normalise(
    { enabled: 1, maxMentionsPerRow: 5.4, scope: 'ts', bashEdits: 'yes', mime: 0, maxFiles: 5.5 },
    fileConfig.defaults,
    warn,
  )
  expect(bad).toEqual(fileConfig.defaults)
  expect(list.slice(1)).toEqual([
    'enabled: 1 is not true or false. Using true.',
    'scope: "ts" is not one of all, md. Using all.',
    'maxMentionsPerRow: 5.4 is not a whole number. Using 20.',
    'maxFiles: 5.5 is not a whole number. Using 300.',
    'bashEdits: "yes" is not true or false. Using true.',
    'mime: 0 is not true or false. Using true.',
  ])
})

test('config: maxFiles keeps 50 to 2000', () => {
  const warn = () => {}
  expect(fileConfig.normalise({ maxFiles: 10 }, fileConfig.defaults, warn).maxFiles).toBe(50)
  expect(fileConfig.normalise({ maxFiles: 5000 }, fileConfig.defaults, warn).maxFiles).toBe(2000)
  expect(fileConfig.normalise({ maxFiles: 50 }, fileConfig.defaults, warn).maxFiles).toBe(50)
})

// ---------------------------------------------------------------- the cap of the file rows (issue #57, G1)

/** `n` Reads of files `r0` ... `r<n-1>`, one after the other. */
async function reads(t: ReturnType<typeof world>, n: number, prefix = 'r'): Promise<void> {
  for (let i = 0; i < n; i++) {
    await t.w.clock.advance(1) // a later lastSeen for each file
    await t.tool('Read', viewed(`/work/${prefix}${i}.txt`))
  }
}

test('maxFiles caps the file rows, and a file that was written outlives the older files that were only read', async () => {
  const t = world({ slice: { maxFiles: 50 } })
  await t.tool('Write', created('/work/keep.ts')) // the oldest row, and written
  await reads(t, 60)
  const rows = t.files()
  expect(rows).toHaveLength(50)
  expect(rows[0]).toMatchObject({ label: '/work/keep.ts', created: true })
  // The reads that went are the oldest ones.
  expect(t.rec('/work/r0.txt')).toBeUndefined()
  expect(t.rec('/work/r59.txt')).toBeDefined()
})

test('a file that was only named goes after the files that were only read', async () => {
  const t = world({ slice: { maxFiles: 50 } })
  t.w.files['/work/named.md'] = 'x'
  await t.say('see named.md') // a mention, the oldest row
  await reads(t, 55)
  expect(t.rec('/work/named.md')).toMatchObject({ mentions: 1 })
  expect(t.files()).toHaveLength(50)
})

test('the file cap is a limit of the file kind: other items are never dropped for it', async () => {
  const t = world({ slice: { maxFiles: 50 } })
  const other = {
    key: 'web:https://a.example/',
    category: 'web',
    url: 'https://a.example/',
    label: 'A',
    sources: ['response'],
  }
  t.w.state.set('items', [
    {
      ...other,
      reasons: { first: 'mentioned', all: ['mentioned'], strongest: 'mentioned' },
      firstSeen: 1,
      lastSeen: 1,
      seenCount: 1,
    },
  ] as never)
  await reads(t, 60)
  expect(t.keys()).toContain('web:https://a.example/')
  expect(t.files()).toHaveLength(50)
})

test('maxFiles above the shared cap lifts nothing: global.store.maxItems still applies', async () => {
  const t = world({ slice: { maxFiles: 2000 }, global: { store: { maxItems: 200 } } })
  await reads(t, 210)
  expect(t.files()).toHaveLength(200)
})

// ---------------------------------------------------------------- the /track text (issue #57, R5 and G16)

test('the /track text lists the written files and counts the read ones in one line, in the list view and in another', async () => {
  const t = world()
  await t.tool('Write', created('/work/a.ts'))
  for (const name of ['r1.ts', 'r2.ts']) await t.tool('Read', viewed(`/work/${name}`))
  expect(await listText(t.w.ports, t.m)).toBe(
    'Files  1 files · 2 read\n  a.ts  code  created\n  2 more files read only',
  )
  // Another view mixes the rows of every section: the quiet rows print nothing, and the line comes once at the end.
  await t.w.ports.state.view.update(() => 'flat')
  const flat = await listText(t.w.ports, t.m)
  expect(flat).toBe('View: flat\n\nAll\n  a.ts  code  created\n\nFiles  2 more files read only')
  expect(flat).not.toContain('r1.ts')
})

test('the pane draws every file row, dim for the read ones; the tracker marks no row quiet, the view does', async () => {
  const t = world()
  await t.tool('Write', created('/work/a.ts'))
  for (const name of ['r1.ts', 'r2.ts']) await t.tool('Read', viewed(`/work/${name}`))
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(sections.flatMap(s => s.rows).map(r => [r.cells.name?.text, r.dim === true, r.quiet === true])).toEqual([
    ['a.ts', false, false],
    ['r1.ts', true, false],
    ['r2.ts', true, false],
  ])
  const [group] = viewGroups(sections, 'list', { touchedOnly: false }).groups
  expect(group?.rows.map(r => [r.cells.name?.text, r.quiet === true])).toEqual([
    ['a.ts', false],
    ['r1.ts', true],
    ['r2.ts', true],
  ])
})

test('the /track text of files that were all read has the title line and the count line only', async () => {
  const t = world()
  await t.tool('Read', viewed('/work/r1.ts'))
  expect(await listText(t.w.ports, t.m)).toBe('Files  0 files · 1 read\n  1 more file read only')
})

test('a file that was only read and that the person marked high is listed in the /track text, in every view', async () => {
  const t = world()
  await t.tool('Write', created('/work/a.ts'))
  for (const name of ['p.ts', 'r1.ts']) await t.tool('Read', viewed(`/work/${name}`))
  await t.m.setPriority(t.w.ports, 'file:/work/p.ts', 'high')
  // The mark pins the row: the by-list view moves it to the Pinned group, and the text prints it, not only counts it.
  expect(await listText(t.w.ports, t.m)).toBe(
    'Pinned\n  ▲ p.ts  code  viewed 1\n\nFiles  2 files · 1 read\n  a.ts  code  created\n  1 more file read only',
  )
  await t.w.ports.state.view.update(() => 'flat')
  const flat = await listText(t.w.ports, t.m)
  expect(flat).toContain('▲ p.ts')
  expect(flat).not.toContain('r1.ts')
  expect(flat).toContain('Files  1 more file read only')
})

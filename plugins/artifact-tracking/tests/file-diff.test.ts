// The diff mode of the file preview (issue #254, L3 of #57): `d` shows the working tree against the merge-base with the base of the
// PR of the session branch, else with `origin/HEAD`. Through the LifecycleManager over fakePorts, with a fake `git` that answers the
// shapes that the design study ran on a real one (P4): the item list, the facts and the preview service are the real ones.
// Design study R15, R16, R17 (diff part), G13, G14: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787
import { expect, test } from 'claude-code/testing'
import { Facts } from '../core/infra/facts'
import type { Json, JsonObject } from '../core/interfaces/items'
import type { FsStat, RunResult } from '../core/interfaces/ports'
import { fileTracker } from '../trackers/file'
import { clearOff, markOff, OFF_TTL_MS, offReason } from '../trackers/file/diff-off'
import { FACT_DIFF_OFF } from '../trackers/file/facts'
import { fakeConfig } from './fixtures/config-fs'
import { res } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

const SHA = '1efdf45aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HEAD_BYTES = '262144'

const CHANGED = `diff --git a/a.ts b/a.ts
index de98044..5d9294b 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 a
-b
-c
+B
+C
+d
`
const CHANGED_HUNKS = '@@ -1,3 +1,4 @@\n a\n-b\n-c\n+B\n+C\n+d\n'
const UNTRACKED = `diff --git a/a.ts b/a.ts
new file mode 100644
index 0000000..07f33c4
--- /dev/null
+++ b/a.ts
@@ -0,0 +1,2 @@
+new
+file
`
const DELETED = `diff --git a/a.ts b/a.ts
deleted file mode 100644
index 286c5f5..0000000
--- a/a.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`
const BINARY = 'diff --git a/a.ts b/a.ts\nindex f48ba66..3d6dcf3 100644\nBinary files a/a.ts and b/a.ts differ\n'

type Table = Record<string, RunResult | undefined>

/** The words of a git call after its global options (`--no-optional-locks`, `-c key=value`): `diff …`, `merge-base HEAD x`. */
function subOf(argv: readonly string[]): string {
  let i = 1
  while (argv[i]?.startsWith('-')) i += argv[i] === '-c' ? 2 : 1
  return argv.slice(i).join(' ')
}

/** The key a scripted git answer has: the word, and for a diff which kind (`diff`, `diff --no-index`). */
function keyOf(sub: string): string {
  if (sub.startsWith('diff ') && sub.split(' ').includes('--no-index')) return 'diff --no-index'
  if (sub.startsWith('diff ')) return 'diff'
  if (sub.startsWith('ls-files')) return 'ls-files'
  if (sub.startsWith('cat-file')) return 'cat-file'
  return sub
}

/**
 * A world with the file tracker alone. `git` answers from `o.git` by `keyOf`, and an unscripted call answers as git does outside
 * a repo, so a call that a test did not expect shows as a notice. `head` answers from the files of the world.
 */
function world(o: { slice?: JsonObject; git?: Table; dirs?: readonly string[] } = {}) {
  const git: Table = { 'rev-parse --show-toplevel': res('/work\n'), ...o.git }
  const calls: { argv: string[]; sub: string }[] = []
  const t = managerWorld({
    trackers: () => [fileTracker()],
    config: specs =>
      fakeConfig({ specs, file: { version: 1, trackers: { file: { mime: false, ...o.slice } as JsonObject } } }),
    run: async argv => {
      if (argv[0] === 'head') {
        const text = t.w.files[argv[argv.length - 1] as string]
        return text === undefined ? res('', 1, 'head: no such file') : res(text.slice(0, Number(argv[2])))
      }
      if (argv[0] !== 'git') return undefined
      const sub = subOf(argv)
      calls.push({ argv, sub })
      return git[keyOf(sub)] ?? res('', 128, `fatal: unscripted git call: ${sub}`)
    },
  })
  t.w.env.HOME = '/home/u'
  t.m.facts.publish('auto.root', { cwd: '/work', top: '/work', at: 1 })
  const stat = t.w.ports.fs.stat
  t.w.ports.fs.stat = async (path, opts): Promise<FsStat | null> =>
    o.dirs?.includes(path) ? { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : stat(path, opts)
  const track = async (path: string, text?: string) => {
    if (text !== undefined) t.w.files[path] = text
    await t.call(
      'Write',
      { file_path: path },
      { result: { type: 'create', filePath: path, content: 'x', structuredPatch: [], originalFile: null } },
    )
    return `file:${path}`
  }
  const prFact = (
    v: Json | null = { host: 'github.com', owner: 'acme', repo: 'web', number: 9, base: 'main', head: 'feat/x' },
  ) => t.m.facts.publish('github.branchPr', v ?? undefined)
  const diff = (key: string) => t.m.loadPreview(t.w.ports, 'file', key, 'diff')
  /** The calls to git, as the words after the global options, in order. */
  const subs = () => calls.map(c => c.sub)
  return { ...t, calls, track, prFact, diff, subs, git }
}

const noticesOf = (c: { blocks: readonly { kind: string; text?: string }[] }) =>
  c.blocks.flatMap(b => (b.kind === 'notice' ? [b.text] : []))
const blocksOf = (c: { blocks: readonly { kind: string }[] }) => c.blocks.map(b => b.kind)

const TRACKED: Table = {
  'symbolic-ref --short -q HEAD': res('feat/x\n'),
  'merge-base HEAD origin/main': res(`${SHA}\n`),
  'merge-base HEAD origin/HEAD': res(`${SHA}\n`),
  diff: res(CHANGED),
  'ls-files': res('a.ts\n'),
}

test('modes: a tracked file has the view and the diff, both on, also when the file is gone; an untracked row has no preview', async () => {
  const t = world()
  const key = await t.track('/work/a.ts', 'x')
  expect(await t.m.previewModes(t.w.ports, 'file', key)).toEqual([
    { id: 'view', enabled: true },
    { id: 'diff', enabled: true },
  ])
  delete t.w.files['/work/a.ts']
  expect((await t.m.previewModes(t.w.ports, 'file', key))?.map(m => [m.id, m.enabled])).toEqual([
    ['view', true],
    ['diff', true],
  ])
  expect(await t.m.previewModes(t.w.ports, 'file', 'file:/work/none.ts')).toBeUndefined()
})

// R16 of the design study, and M1 of the review of #289: without a repo or a base the diff mode is off, with the reason. `modes()` is
// pure and cannot ask git, so the view starts a probe apart from the hook (`clock.after(0)`, as the type lookup does), `d` itself marks
// what it finds, and `modes()` reads the fact `file.diffOff`: a dim Button, and a toast with the reason at a press (core, L2).
const NO_REPO = res('', 128, 'fatal: not a git repository (or any of the parent directories): .git')
const NOT_A_REPO = 'Not in a git repository, so there is nothing to diff against.'
const NO_ORIGIN =
  'No base to diff against: origin/HEAD is not set in this repository (git remote set-head origin --auto sets it).'
const GONE = res('', 128, 'fatal: Not a valid object name')

type World = ReturnType<typeof world>
/** The view of the row opened, and the probe that it starts, run to its end. */
async function probed(t: World, key: string) {
  await t.m.loadPreview(t.w.ports, 'file', key, 'view')
  await t.w.clock.advance(0)
}
/** What the fact `file.diffOff` holds for a folder, as it is stored. */
const entryOf = (facts: Pick<Facts, 'read'>, folder: string) => facts.read<JsonObject>(FACT_DIFF_OFF)?.[folder]
const diffMode = async (t: World, key: string) =>
  (await t.m.previewModes(t.w.ports, 'file', key))?.find(m => m.id === 'diff')

test('R16: not in a repository: once the view has asked git, the diff mode is off with the reason, and the view stays on', async () => {
  const t = world({ git: { 'rev-parse --show-toplevel': NO_REPO } })
  const key = await t.track('/etc/hosts', '127.0.0.1 localhost')
  await t.m.loadPreview(t.w.ports, 'file', key, 'view')
  expect(t.calls).toEqual([]) // the view runs no git: the probe comes after the hook
  expect(await diffMode(t, key)).toEqual({ id: 'diff', enabled: true }) // nothing known yet: the press asks git
  await t.w.clock.advance(0)
  expect(t.subs()).toEqual(['rev-parse --show-toplevel'])
  expect(await t.m.previewModes(t.w.ports, 'file', key)).toEqual([
    { id: 'view', enabled: true },
    { id: 'diff', enabled: false, reason: NOT_A_REPO },
  ])
  // Another folder is another answer: it has not been asked.
  expect(await diffMode(t, await t.track('/work/a.ts', 'x'))).toEqual({ id: 'diff', enabled: true })
})

test('R16: no origin/HEAD, or no common ancestor, or no PR base in this clone: the diff mode is off with the notice of the diff', async () => {
  const cases: [string, Record<string, RunResult>, boolean, string][] = [
    ['no origin/HEAD', { 'merge-base HEAD origin/HEAD': GONE }, false, NO_ORIGIN],
    [
      'no common ancestor',
      { 'merge-base HEAD origin/HEAD': res('', 1) },
      false,
      'No base to diff against: HEAD and origin/HEAD have no common ancestor.',
    ],
    [
      'a PR base that is not in this clone',
      {
        'merge-base HEAD origin/main': GONE,
        'merge-base HEAD refs/heads/main': GONE,
        'merge-base HEAD origin/HEAD': GONE,
      },
      true,
      'No base to diff against: neither the base of the PR (main) nor origin/HEAD is in this clone (git fetch origin, then git remote set-head origin --auto).',
    ],
  ]
  for (const [name, git, pr, reason] of cases) {
    const t = world({ git: { ...TRACKED, ...git } })
    if (pr) t.prFact()
    const key = await t.track('/work/a.ts', 'x')
    await probed(t, key)
    expect(await diffMode(t, key), name).toEqual({ id: 'diff', enabled: false, reason })
    expect(
      t.subs().some(s => s.startsWith('diff ')),
      name,
    ).toBe(false) // the probe asks for a base, not for the diff
  }
})

test('R16: git that cannot start, or that is refused for the repo, turns the diff mode off with its words', async () => {
  const t = world()
  const run = t.w.run
  t.w.run = async argv => {
    if (argv[0] === 'git') throw new Error('spawn git ENOENT')
    return run?.(argv)
  }
  const key = await t.track('/work/a.ts', 'x')
  await probed(t, key)
  expect(await diffMode(t, key)).toEqual({ id: 'diff', enabled: false, reason: 'Could not run git: spawn git ENOENT' })
  const refused = world({
    git: { 'rev-parse --show-toplevel': res('', 128, "fatal: detected dubious ownership in repository at '/work'") },
  })
  const row = await refused.track('/work/a.ts', 'x')
  await probed(refused, row)
  expect(await diffMode(refused, row)).toEqual({
    id: 'diff',
    enabled: false,
    reason: "git could not use the repository: fatal: detected dubious ownership in repository at '/work'",
  })
})

test('R16: a folder with a repo and a base keeps both modes on, and the probe asks for no diff', async () => {
  const t = world({ git: TRACKED })
  const key = await t.track('/work/a.ts', 'x')
  await probed(t, key)
  expect(await t.m.previewModes(t.w.ports, 'file', key)).toEqual([
    { id: 'view', enabled: true },
    { id: 'diff', enabled: true },
  ])
  expect(t.m.facts.read('file.diffOff')).toBeUndefined()
  expect(t.subs()).toEqual(['rev-parse --show-toplevel', 'merge-base HEAD origin/HEAD'])
})

test('R16: the answer holds for a minute: after that the diff mode is on again, so a repo that came in the meantime can be asked', async () => {
  const t = world({ git: { 'rev-parse --show-toplevel': NO_REPO } })
  const key = await t.track('/etc/hosts', 'x')
  await t.w.clock.advance(1000) // the wall clock starts at 0: an answer stamped with 0 would pass for a right one
  await probed(t, key)
  expect(entryOf(t.m.facts, '/etc')).toEqual({ reason: NOT_A_REPO, at: 1000 }) // stamped with the wall time, not with 0
  await t.w.clock.advance(OFF_TTL_MS - 1)
  expect((await diffMode(t, key))?.enabled).toBe(false)
  await t.w.clock.advance(1)
  expect(await diffMode(t, key)).toEqual({ id: 'diff', enabled: true })
})

test('R16: a visit of the view asks again, so a repo that came in the meantime turns the mode on', async () => {
  const t = world({ git: { 'rev-parse --show-toplevel': NO_REPO } })
  const key = await t.track('/work/a.ts', 'x')
  await probed(t, key)
  expect((await diffMode(t, key))?.enabled).toBe(false)
  Object.assign(t.git, TRACKED, { 'rev-parse --show-toplevel': res('/work\n') })
  await probed(t, key)
  expect(await diffMode(t, key)).toEqual({ id: 'diff', enabled: true })
  expect(t.m.facts.read('file.diffOff')).toBeUndefined()
})

test('R16: a diff that is asked for and finds a base turns the mode on; one that finds none turns it off, with no probe before', async () => {
  const t = world({ git: { 'rev-parse --show-toplevel': NO_REPO } })
  const key = await t.track('/work/a.ts', 'x')
  expect(noticesOf(await t.diff(key))).toEqual([NOT_A_REPO])
  expect(await diffMode(t, key)).toEqual({ id: 'diff', enabled: false, reason: NOT_A_REPO })
  Object.assign(t.git, TRACKED, { 'rev-parse --show-toplevel': res('/work\n') }) // a repo came
  await t.diff(key)
  expect(await diffMode(t, key)).toEqual({ id: 'diff', enabled: true })
})

test('R16: a Bash command that makes a repo or a remote (init, clone, fetch, remote, pull, checkout, switch) withdraws every answer, and others do not', async () => {
  const t = world({ git: { 'rev-parse --show-toplevel': NO_REPO } })
  const key = await t.track('/work/a.ts', 'x')
  await probed(t, key)
  const bash = (command: unknown) => t.call('Bash', { command }, { result: { stdout: '', stderr: '' } })
  for (const harmless of ['ls -la', 'git status', 'git log --oneline', 'git diff HEAD', 'echo done', 42]) {
    await bash(harmless)
    expect((await diffMode(t, key))?.enabled, String(harmless)).toBe(false)
  }
  for (const command of [
    'git init',
    'git clone https://example.test/x.git',
    'cd /work && git fetch origin',
    'git -C /work remote add origin https://example.test/x.git',
    'git remote set-head origin --auto',
    'git pull --rebase',
    'git checkout main',
    'git switch -c feat/x',
  ]) {
    await probed(t, key) // off again
    expect((await diffMode(t, key))?.enabled, command).toBe(false)
    await bash(command)
    expect((await diffMode(t, key))?.enabled, command).toBe(true)
  }
})

test('R16: a session switch withdraws every answer', async () => {
  const facts = new Facts()
  markOff(facts, '/etc', NOT_A_REPO, 1000)
  expect(offReason(facts, '/etc', 1000)).toBe(NOT_A_REPO)
  await fileTracker().events?.sessionChanged?.({ facts } as never, { from: 'a', to: 'b', kind: 'clear' } as never)
  expect(facts.read(FACT_DIFF_OFF)).toBeUndefined()
})

const ROWS = (facts: Facts) => Object.keys(facts.read<JsonObject>(FACT_DIFF_OFF) ?? {})

test('R16: the fact keeps the newest 64 folders: the 65th answer pushes the oldest out, and an answer for a folder that is there replaces it', () => {
  const facts = new Facts()
  for (let i = 0; i < 70; i++) markOff(facts, `/d${i}`, `reason ${i}`, 1000 + i) // all within the hold: only the cap prunes
  const rows = ROWS(facts)
  expect(rows).toHaveLength(64)
  expect(rows).toContain('/d69')
  expect(rows).toContain('/d6')
  for (const gone of ['/d0', '/d1', '/d5']) expect(rows).not.toContain(gone)
  markOff(facts, '/d30', 'newer', 1100)
  expect(ROWS(facts)).toHaveLength(64) // the same folder twice is one row
  expect(entryOf(facts, '/d30')).toEqual({ reason: 'newer', at: 1100 })
})

test('R16: a write drops the answers that are old by then: one that is OFF_TTL_MS old goes, one a millisecond younger stays', () => {
  const facts = new Facts()
  markOff(facts, '/a', NOT_A_REPO, 1000)
  markOff(facts, '/b', NOT_A_REPO, 1000 + OFF_TTL_MS - 1)
  expect(ROWS(facts)).toEqual(['/a', '/b']) // /a is OFF_TTL_MS - 1 old: it holds
  markOff(facts, '/c', NOT_A_REPO, 1000 + OFF_TTL_MS)
  expect(ROWS(facts)).toEqual(['/b', '/c']) // /a is OFF_TTL_MS old: it is out. /b is one millisecond old
})

test('R16: clearOff of one folder drops the answer of that folder only: the answer of another folder stays', () => {
  const facts = new Facts()
  markOff(facts, '/a', NOT_A_REPO, 1000)
  markOff(facts, '/b', NOT_A_REPO, 1000)
  clearOff(facts, '/a')
  expect(offReason(facts, '/a', 1000)).toBeUndefined()
  expect(offReason(facts, '/b', 1000)).toBe(NOT_A_REPO)
})

test('R16: a part of the fact in another shape answers nothing, and the next write drops it', () => {
  const facts = new Facts()
  facts.publish(FACT_DIFF_OFF, {
    '/ok': { reason: NOT_A_REPO, at: 1000 },
    '/null': null,
    '/text': 'not a repository',
    '/reason': { reason: 5, at: 1000 },
    '/at': { reason: NOT_A_REPO, at: '1000' },
  })
  expect(offReason(facts, '/ok', 1000)).toBe(NOT_A_REPO)
  for (const folder of ['/null', '/text', '/reason', '/at'])
    expect(offReason(facts, folder, 1000), folder).toBeUndefined()
  markOff(facts, '/new', NOT_A_REPO, 1000)
  expect(ROWS(facts)).toEqual(['/ok', '/new'])
})

test('R16: a timer that the engine refuses to start never stops the probe of a folder: the next view asks again', async () => {
  const t = world({ git: { 'rev-parse --show-toplevel': NO_REPO } })
  const key = await t.track('/work/a.ts', 'x')
  const after = t.w.ports.clock.after
  let refused = 1
  t.w.ports.clock.after = (ms, fn) => {
    if (refused-- > 0) throw new Error('timer refused')
    return after(ms, fn)
  }
  // The refusal reaches the view as a throw: the view still draws, and the folder is not marked as busy.
  expect((await t.m.loadPreview(t.w.ports, 'file', key, 'view')).blocks.map(b => b.kind)).toEqual(['code'])
  await t.w.clock.advance(0)
  expect(t.calls).toEqual([])
  await probed(t, key)
  expect(t.subs()).toEqual(['rev-parse --show-toplevel'])
  expect((await diffMode(t, key))?.enabled).toBe(false)
})

test('R16: a probe whose timer never fires holds its folder for 30 s (PROBE_HOLD_MS), and not longer', async () => {
  const HOLD_MS = 30_000 // the number is the rule: a folder is not asked twice while a probe runs, and a lost probe must not stop it for good
  const t = world({ git: { 'rev-parse --show-toplevel': NO_REPO } })
  const key = await t.track('/work/a.ts', 'x')
  const probes = () => t.subs().filter(s => s === 'rev-parse --show-toplevel').length
  const view = async () => {
    await t.m.loadPreview(t.w.ports, 'file', key, 'view')
    await t.w.clock.advance(0)
  }
  await t.w.clock.advance(1000) // the wall clock starts at 0: the age of a probe is a difference, so it must not be read as a sum
  t.w.clock.refuse('after', 1) // `after(0)` is armed as 1 ms: the engine drops the timer of the first probe, so it never ends
  await view()
  expect(probes()).toBe(0)
  await t.w.clock.advance(HOLD_MS - 1)
  await view()
  expect(probes()).toBe(0) // a millisecond before the hold ends: the folder is still held
  await t.w.clock.advance(1)
  await view()
  expect(probes()).toBe(1) // the hold is over: the folder asks
})

test('R16: a file whose folders are all gone has the diff mode off with that reason, from a press of d and from the probe alike', async () => {
  const gone = 'The file and its folders are gone, so there is no diff.'
  for (const how of ['press', 'probe'] as const) {
    const t = world({ git: TRACKED })
    const key = await t.track('/work/old/a.ts', 'x')
    delete t.w.files['/work/old/a.ts']
    if (how === 'press') await t.diff(key)
    else await probed(t, key)
    expect(await diffMode(t, key), how).toEqual({ id: 'diff', enabled: false, reason: gone })
    expect(t.calls, how).toEqual([])
  }
})

test('R16: git that cannot start at a press of d turns the diff mode off with its words, whichever call fails', async () => {
  const why = 'Could not run git: spawn git ENOENT'
  for (const failing of ['rev-parse', 'diff']) {
    const t = world({ git: TRACKED })
    const run = t.w.run
    t.w.run = async argv => {
      if (argv[0] === 'git' && subOf(argv).startsWith(failing)) throw new Error('spawn git ENOENT')
      return run?.(argv)
    }
    const key = await t.track('/work/a.ts', 'x')
    expect((await t.diff(key)).blocks, failing).toEqual([{ kind: 'notice', text: why, tone: 'warning' }])
    expect(await diffMode(t, key), failing).toEqual({ id: 'diff', enabled: false, reason: why })
  }
})

test('R16: a secret file asks git for nothing at the view, and three presses of v at once ask once', async () => {
  const t = world({ git: TRACKED })
  await probed(t, await t.track('/work/.env', 'TOP-SECRET=1'))
  expect(t.calls).toEqual([])
  const key = await t.track('/work/a.ts', 'x')
  for (let i = 0; i < 3; i++) await t.m.loadPreview(t.w.ports, 'file', key, 'view')
  await t.w.clock.advance(0)
  expect(t.subs().filter(s => s === 'rev-parse --show-toplevel')).toHaveLength(1) // three presses of v, one probe
  await t.m.loadPreview(t.w.ports, 'file', key, 'view') // the probe has ended: a new press asks again
  await t.w.clock.advance(0)
  expect(t.subs().filter(s => s === 'rev-parse --show-toplevel')).toHaveLength(2)
})

test('diff: the hunks of the working tree against the merge-base with the base of the PR of the session branch, and the header says which base', async () => {
  const t = world({ git: TRACKED })
  t.prFact()
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content).toEqual({
    title: 'a.ts',
    subtitle: 'code · diff · vs origin/main @ 1efdf45 · +3 -2',
    blocks: [{ kind: 'diff', source: CHANGED_HUNKS, path: '/work/a.ts' }],
  })
  expect(t.subs()).toEqual([
    'rev-parse --show-toplevel',
    'symbolic-ref --short -q HEAD',
    'merge-base HEAD origin/main',
    `diff --no-ext-diff --no-textconv --no-color --no-renames --ignore-submodules=dirty --unified=3 ${SHA} -- a.ts`,
  ])
})

const PIN = [
  'git',
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.relative=false',
]

/** Every call to git of the world has the global options first, runs in a folder, has no shell, a 5 s timeout and `LC_ALL=C`. */
function expectEveryCallPinned(t: World) {
  const calls = t.w.calls.flatMap((argv, i) => (argv[0] === 'git' ? [{ argv, opts: t.w.callOpts[i] }] : []))
  expect(calls.length).toBeGreaterThan(0)
  for (const { argv, opts } of calls) {
    expect(argv.slice(0, PIN.length), argv.join(' ')).toEqual(PIN)
    expect(opts, argv.join(' ')).toMatchObject({ env: { LC_ALL: 'C' }, timeoutMs: 5000 })
    expect(typeof opts?.cwd, argv.join(' ')).toBe('string')
  }
}

test('diff: the git argv is pinned, with no shell: global options first, the path after `--`, literal, in the folder of the file', async () => {
  const t = world({ git: TRACKED })
  t.prFact()
  await t.diff(await t.track('/work/src/a.ts', 'x'))
  const pin = PIN
  expect(t.w.calls.filter(c => c[0] === 'git')).toEqual([
    [...pin, 'rev-parse', '--show-toplevel'],
    [...pin, 'symbolic-ref', '--short', '-q', 'HEAD'],
    [...pin, 'merge-base', 'HEAD', 'origin/main'],
    [
      ...pin,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--ignore-submodules=dirty',
      '--unified=3',
      SHA,
      '--',
      'a.ts',
    ],
  ])
  const opts = t.w.callOpts.filter((_, i) => t.w.calls[i]?.[0] === 'git')
  for (const o of opts) expect(o).toMatchObject({ cwd: '/work/src', env: { LC_ALL: 'C' }, timeoutMs: 5000 })
})

test('diff: a PR that stacks on another branch diffs against that branch', async () => {
  const t = world({ git: { ...TRACKED, 'merge-base HEAD origin/feat/file-preview': res(`${SHA}\n`) } })
  t.prFact({ host: 'github.com', owner: 'acme', repo: 'web', number: 9, base: 'feat/file-preview', head: 'feat/x' })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.subtitle).toContain('vs origin/feat/file-preview @ 1efdf45')
  expect(t.subs()).toContain('merge-base HEAD origin/feat/file-preview')
  expect(t.subs()).not.toContain('merge-base HEAD origin/HEAD')
})

test('diff: a PR base that origin does not have falls back to the local branch of that name', async () => {
  const t = world({
    git: {
      ...TRACKED,
      'merge-base HEAD origin/main': res('', 128, 'fatal: Not a valid object name origin/main'),
      'merge-base HEAD refs/heads/main': res(`${SHA}\n`),
    },
  })
  t.prFact()
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.subtitle).toContain('vs main @ 1efdf45')
  expect(t.subs().filter(s => s.startsWith('merge-base'))).toEqual([
    'merge-base HEAD origin/main',
    'merge-base HEAD refs/heads/main',
  ])
})

test('diff: a PR base that this clone has not, local or remote, falls back to origin/HEAD and says so in a notice', async () => {
  const gone = res('', 128, 'fatal: Not a valid object name')
  const t = world({ git: { ...TRACKED, 'merge-base HEAD origin/main': gone, 'merge-base HEAD refs/heads/main': gone } })
  t.prFact()
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.subtitle).toContain('vs origin/HEAD @ 1efdf45')
  expect(noticesOf(content)).toEqual([
    'The base of the PR (main) is not in this clone, so the diff is against origin/HEAD. Fetch the base branch to diff against the PR.',
  ])
  expect(blocksOf(content)).toEqual(['notice', 'diff'])
})

test('diff: a base name that git or a prompt could take for more than a name is never an argument, and origin/HEAD is the base', async () => {
  const t = world({ git: TRACKED })
  const key = await t.track('/work/a.ts', 'x')
  for (const base of [
    '-x',
    'a..b',
    'a b',
    'x;rm',
    'a/',
    'a.lock',
    '$(id)',
    'a^',
    'a:b',
    'a~1',
    '@{u}',
    '.hidden',
    'a//b',
  ]) {
    t.calls.length = 0
    t.prFact({ host: 'github.com', owner: 'acme', repo: 'web', number: 9, base, head: 'feat/x' })
    const content = await t.diff(key)
    expect(content.subtitle, base).toContain('vs origin/HEAD')
    expect(
      t.subs().filter(s => s.startsWith('merge-base')),
      base,
    ).toEqual(['merge-base HEAD origin/HEAD'])
    expect(
      t.w.calls.flat().some(word => word.includes(base)),
      base,
    ).toBe(false)
    // The diff does not go quiet against another base than the PR's (n7 of the review of #289): the notice says why.
    expect(noticesOf(content), base).toEqual([
      `The base of the PR (${base}) is not a plain branch name, so the diff is against origin/HEAD.`,
    ])
  }
})

test('diff: a PR base that is no plain name says nothing when the PR does not apply: another repo, or the repo is on another branch', async () => {
  const t = world({ git: { ...TRACKED, 'rev-parse --show-toplevel': res('/other/repo\n') } })
  t.prFact({ host: 'github.com', owner: 'acme', repo: 'web', number: 9, base: 'a b', head: 'feat/x' })
  expect(noticesOf(await t.diff(await t.track('/other/repo/a.ts', 'x')))).toEqual([])
  const away = world({ git: { ...TRACKED, 'symbolic-ref --short -q HEAD': res('feat/other\n') } })
  away.prFact({ host: 'github.com', owner: 'acme', repo: 'web', number: 9, base: 'a b', head: 'feat/x' })
  expect(noticesOf(await away.diff(await away.track('/work/a.ts', 'x')))).toEqual([])
})

test('diff: with no PR the base is origin/HEAD, and a stale fact (the repo is on another branch now) is not used', async () => {
  const t = world({ git: TRACKED })
  const key = await t.track('/work/a.ts', 'x')
  const none = await t.diff(key)
  expect(none.subtitle).toContain('vs origin/HEAD @ 1efdf45')
  expect(t.subs()).toEqual([
    'rev-parse --show-toplevel',
    'merge-base HEAD origin/HEAD',
    `diff --no-ext-diff --no-textconv --no-color --no-renames --ignore-submodules=dirty --unified=3 ${SHA} -- a.ts`,
  ])
  t.calls.length = 0
  t.prFact({ host: 'github.com', owner: 'acme', repo: 'web', number: 9, base: 'main', head: 'feat/other' })
  expect((await t.diff(key)).subtitle).toContain('vs origin/HEAD')
  expect(t.subs()).toContain('symbolic-ref --short -q HEAD')
  expect(t.subs()).not.toContain('merge-base HEAD origin/main')
})

test('diff: the PR base applies to the session repo only: a file in another repo diffs against the origin/HEAD of that repo', async () => {
  const t = world({ git: { ...TRACKED, 'rev-parse --show-toplevel': res('/other/repo\n') } })
  t.prFact()
  const content = await t.diff(await t.track('/other/repo/a.ts', 'x'))
  expect(content.subtitle).toContain('vs origin/HEAD')
  expect(t.subs()).not.toContain('symbolic-ref --short -q HEAD')
  const root = t.w.callOpts.find((_, i) => t.w.calls[i]?.[0] === 'git')
  expect(root).toMatchObject({ cwd: '/other/repo' })
})

test('diff: with no root of the session known, the PR base is not used: nothing proves that the file is in the session repo', async () => {
  const t = world({ git: TRACKED })
  t.m.facts.publish('auto.root', { cwd: '/work', top: null, at: 1 })
  t.prFact()
  await t.diff(await t.track('/work/a.ts', 'x'))
  expect(t.subs()).not.toContain('merge-base HEAD origin/main')
})

test('diff: not in a repository is a notice with the reason, and git is asked once', async () => {
  const t = world({
    git: {
      'rev-parse --show-toplevel': res('', 128, 'fatal: not a git repository (or any of the parent directories): .git'),
    },
  })
  const content = await t.diff(await t.track('/etc/hosts', '127.0.0.1 localhost'))
  expect(noticesOf(content)).toEqual(['Not in a git repository, so there is nothing to diff against.'])
  expect(blocksOf(content)).toEqual(['notice'])
  expect(t.subs()).toEqual(['rev-parse --show-toplevel'])
})

test('diff: a repo that git refuses (a failure that is not "not a repository") gives its own first line', async () => {
  const t = world({
    git: {
      'rev-parse --show-toplevel': res('', 128, "fatal: detected dubious ownership in repository at '/work'\nmore"),
    },
  })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(noticesOf(content)).toEqual([
    "git could not use the repository: fatal: detected dubious ownership in repository at '/work'",
  ])
})

test('diff: git that cannot start is a warning, not a crash', async () => {
  const t = world()
  const run = t.w.run
  t.w.run = async argv => {
    if (argv[0] === 'git') throw new Error('spawn git ENOENT')
    return run?.(argv)
  }
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.blocks).toEqual([{ kind: 'notice', text: 'Could not run git: spawn git ENOENT', tone: 'warning' }])
})

test('diff: no origin/HEAD is a notice that says how to set it', async () => {
  const t = world({
    git: { ...TRACKED, 'merge-base HEAD origin/HEAD': res('', 128, 'fatal: Not a valid object name origin/HEAD') },
  })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(noticesOf(content)).toEqual([
    'No base to diff against: origin/HEAD is not set in this repository (git remote set-head origin --auto sets it).',
  ])
  expect(blocksOf(content)).toEqual(['notice'])
  expect(t.subs()).not.toContain(
    `diff --no-ext-diff --no-textconv --no-color --no-renames --ignore-submodules=dirty --unified=3 ${SHA} -- a.ts`,
  )
})

test('diff: the PR is named in the notice of a missing base only when its base was tried: not when the PR does not apply, or its base is no plain name', async () => {
  const gone = res('', 128, 'fatal: Not a valid object name')
  const noOrigin =
    'No base to diff against: origin/HEAD is not set in this repository (git remote set-head origin --auto sets it).'
  const away = world({
    git: { ...TRACKED, 'symbolic-ref --short -q HEAD': res('feat/other\n'), 'merge-base HEAD origin/HEAD': gone },
  })
  away.prFact() // the repo is on another branch than the head of the PR
  expect(noticesOf(await away.diff(await away.track('/work/a.ts', 'x')))).toEqual([noOrigin])
  const odd = world({ git: { ...TRACKED, 'merge-base HEAD origin/HEAD': gone } })
  odd.prFact({ host: 'github.com', owner: 'acme', repo: 'web', number: 9, base: 'a b', head: 'feat/x' }) // applies, but no ref is tried
  expect(noticesOf(await odd.diff(await odd.track('/work/a.ts', 'x')))).toEqual([noOrigin])
})

test('diff: an answer of merge-base is a base only with exit 0 and a commit: exit 0 with nothing, or a commit with a failure, is none', async () => {
  const noOrigin =
    'No base to diff against: origin/HEAD is not set in this repository (git remote set-head origin --auto sets it).'
  for (const answer of [res('', 0), res(`${SHA}\n`, 128, 'fatal: Not a valid object name')]) {
    const t = world({ git: { ...TRACKED, 'merge-base HEAD origin/HEAD': answer } })
    const content = await t.diff(await t.track('/work/a.ts', 'x'))
    expect(noticesOf(content)).toEqual([noOrigin])
    expect(blocksOf(content)).toEqual(['notice'])
  }
})

test('diff: a branch with no common ancestor with the base is a notice', async () => {
  const t = world({ git: { ...TRACKED, 'merge-base HEAD origin/HEAD': res('', 1) } })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(noticesOf(content)).toEqual(['No base to diff against: HEAD and origin/HEAD have no common ancestor.'])
})

test('diff: with a PR, no base at all is a notice that names the base of the PR and says to fetch', async () => {
  const gone = res('', 128, 'fatal: Not a valid object name')
  const t = world({
    git: {
      ...TRACKED,
      'merge-base HEAD origin/main': gone,
      'merge-base HEAD refs/heads/main': gone,
      'merge-base HEAD origin/HEAD': gone,
    },
  })
  t.prFact()
  expect(noticesOf(await t.diff(await t.track('/work/a.ts', 'x')))).toEqual([
    'No base to diff against: neither the base of the PR (main) nor origin/HEAD is in this clone (git fetch origin, then git remote set-head origin --auto).',
  ])
  const apart = world({
    git: { ...TRACKED, 'merge-base HEAD origin/main': res('', 1), 'merge-base HEAD origin/HEAD': res('', 1) },
  })
  apart.prFact()
  expect(noticesOf(await apart.diff(await apart.track('/work/a.ts', 'x')))).toEqual([
    'No base to diff against: HEAD has no common ancestor with the base of the PR (main) or with origin/HEAD.',
  ])
})

test('diff: a file with no change against the base is a notice that names the base', async () => {
  const t = world({ git: { ...TRACKED, diff: res(''), 'ls-files': res('a.ts\n') } })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.blocks).toEqual([{ kind: 'notice', text: 'No change against origin/HEAD @ 1efdf45.', tone: 'info' }])
  expect(t.subs().at(-1)).toBe('ls-files --error-unmatch -- a.ts')
})

test('diff: a file whose mode alone changed is a notice that says so, and not "no change" (m11 of the review of #289)', async () => {
  const t = world({
    git: {
      ...TRACKED,
      diff: res('diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n'),
      'ls-files': res('a.ts\n'),
    },
  })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(blocksOf(content)).toEqual(['notice'])
  expect(noticesOf(content)).toEqual([
    'The file changed in a way that has no lines to show (its mode, for example), against origin/HEAD @ 1efdf45.',
  ])
})

test('diff: the failures of the untracked flow are warnings with the first line of git, and an answer that git cannot give is no diff (m12)', async () => {
  const warned = async (git: Table, text: string) => {
    const t = world({ git: { ...TRACKED, diff: res(''), ...git } })
    expect((await t.diff(await t.track('/work/a.ts', 'x'))).blocks).toEqual([{ kind: 'notice', text, tone: 'warning' }])
  }
  await warned({ 'ls-files': res('', 128, 'fatal: bad index\nmore') }, 'git ls-files failed: fatal: bad index')
  await warned(
    { 'ls-files': res('', 1), 'diff --no-index': res('', 128, 'fatal: cannot read') },
    'git diff failed: fatal: cannot read',
  )
  const big = world({
    git: {
      ...TRACKED,
      diff: res(''),
      'ls-files': res('', 1),
      'diff --no-index': res(`+${'x'.repeat(1_000_001)}\n`, 1),
    },
  })
  expect(noticesOf(await big.diff(await big.track('/work/a.ts', 'x')))).toEqual([
    'The diff is larger than 1,000,000 bytes: the preview does not draw it. Use git diff in a terminal.',
  ])
  const cut = world({
    git: {
      ...TRACKED,
      diff: res(''),
      'ls-files': res('', 1),
      'diff --no-index': { ...res(UNTRACKED, 1), isStdoutTruncated: true },
    },
  })
  expect(blocksOf(await cut.diff(await cut.track('/work/a.ts', 'x')))).toEqual(['notice'])
})

test('diff: a repo that is on no branch (a detached HEAD) never uses the PR base, and git that answers no top is no repo', async () => {
  const t = world({ git: { ...TRACKED, 'symbolic-ref --short -q HEAD': res('', 1) } })
  t.prFact()
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.subtitle).toContain('vs origin/HEAD')
  expect(t.subs()).not.toContain('merge-base HEAD origin/main')
  const empty = world({ git: { 'rev-parse --show-toplevel': res('', 0) } })
  expect(noticesOf(await empty.diff(await empty.track('/work/a.ts', 'x')))).toEqual([NOT_A_REPO])
})

test('diff: an untracked file shows as fully added (git diff --no-index, exit 1 is the result) with a notice that git does not track it', async () => {
  const t = world({
    git: {
      ...TRACKED,
      diff: res(''),
      'ls-files': res('', 1, 'error: pathspec did not match'),
      'diff --no-index': res(UNTRACKED, 1),
    },
  })
  const content = await t.diff(await t.track('/work/a.ts', 'new\nfile\n'))
  expect(noticesOf(content)).toEqual(['Not tracked by git: the whole file shows as added.'])
  expect(content.blocks.at(-1)).toEqual({ kind: 'diff', source: '@@ -0,0 +1,2 @@\n+new\n+file\n', path: '/work/a.ts' })
  expect(content.subtitle).toBe('code · diff · new file · +2 -0')
  // The flags are the one list of every diff call (m8 of the review of #289), and the global options hold for every git call.
  expect(t.subs().at(-1)).toBe(
    'diff --no-ext-diff --no-textconv --no-color --no-renames --ignore-submodules=dirty --unified=3 --no-index -- /dev/null a.ts',
  )
  expectEveryCallPinned(t)
})

test('diff: an untracked empty file is a notice (git answers a preamble and exit 1), and an untracked file that vanished says that git has no copy', async () => {
  const empty = world({
    git: {
      ...TRACKED,
      diff: res(''),
      'ls-files': res('', 1),
      'diff --no-index': res('diff --git a/a.ts b/a.ts\nnew file mode 100644\nindex 0000000..e69de29\n', 1),
    },
  })
  expect(noticesOf(await empty.diff(await empty.track('/work/a.ts', 'x')))).toEqual(['Not tracked by git, and empty.'])
  const gone = world({ git: { ...TRACKED, diff: res(''), 'ls-files': res('', 1) }, dirs: ['/work'] })
  const key = await gone.track('/work/a.ts', 'x')
  delete gone.w.files['/work/a.ts']
  expect(noticesOf(await gone.diff(key))).toEqual(['The file is gone, and git has no copy of it, so there is no diff.'])
  expect(gone.subs().some(s => s.includes('--no-index'))).toBe(false) // nothing to diff with
})

test('diff: a file that was deleted still shows its diff, a full deletion hunk, and a notice that it is gone', async () => {
  const t = world({ git: { ...TRACKED, diff: res(DELETED) }, dirs: ['/work/src'] })
  const key = await t.track('/work/src/a.ts', 'x')
  delete t.w.files['/work/src/a.ts']
  const content = await t.diff(key)
  expect(noticesOf(content)).toEqual(['The file is deleted: the diff shows what was removed.'])
  expect(content.blocks.at(-1)).toEqual({ kind: 'diff', source: '@@ -1 +0,0 @@\n-gone\n', path: '/work/src/a.ts' })
  expect(content.subtitle).toContain('+0 -1')
})

test('diff: a file whose folder is gone too is diffed from the nearest folder that is there, with the rest of the path', async () => {
  const t = world({ git: { ...TRACKED, diff: res(DELETED) }, dirs: ['/work'] })
  const key = await t.track('/work/old/deep/a.ts', 'x')
  delete t.w.files['/work/old/deep/a.ts']
  await t.diff(key)
  const first = t.w.callOpts.find((_, i) => t.w.calls[i]?.[0] === 'git')
  expect(first).toMatchObject({ cwd: '/work' })
  expect(t.subs().at(-1)).toMatch(/ -- old\/deep\/a\.ts$/)
})

test('diff: the climb to a folder that is there stops after 64 folders: the 64th is found, the 65th is not', async () => {
  // The file sits `levels` folders below `/work`, which is the only folder that is there: `/work` is the folder number `levels + 1` that is asked.
  for (const [levels, found] of [
    [63, true],
    [64, false],
  ] as const) {
    const t = world({ git: { ...TRACKED, diff: res(DELETED) }, dirs: ['/work'] })
    const path = `/work/${'d/'.repeat(levels)}a.ts`
    const key = await t.track(path, 'x')
    delete t.w.files[path]
    const content = await t.diff(key)
    if (found) {
      expect(blocksOf(content), `${levels} folders`).toContain('diff')
      expect(
        t.w.callOpts.find((_, i) => t.w.calls[i]?.[0] === 'git'),
        `${levels} folders`,
      ).toMatchObject({ cwd: '/work' })
    } else {
      expect(noticesOf(content), `${levels} folders`).toEqual([
        'The file and its folders are gone, so there is no diff.',
      ])
      expect(t.calls, `${levels} folders`).toEqual([])
    }
  }
})

test('diff: no folder of the path is there at all is a notice, and git is not run', async () => {
  const t = world({ git: TRACKED })
  const key = await t.track('/work/old/a.ts', 'x')
  delete t.w.files['/work/old/a.ts']
  expect(noticesOf(await t.diff(key))).toEqual(['The file and its folders are gone, so there is no diff.'])
  expect(t.calls).toEqual([])
})

test('diff: a binary file is a notice with its type and size, whether git tracks it or not', async () => {
  const tracked = world({ git: { ...TRACKED, diff: res(BINARY) }, slice: {} })
  tracked.w.files['/work/a.ts'] = 'x'.repeat(2048)
  const content = await tracked.diff(await tracked.track('/work/a.ts'))
  expect(content.blocks).toEqual([
    { kind: 'notice', text: 'Binary file, code, 2.0 KB. The diff shows text only.', tone: 'info' },
  ])
  const fresh = world({
    git: {
      ...TRACKED,
      diff: res(''),
      'ls-files': res('', 1),
      'diff --no-index': res('diff --git a/a.ts b/a.ts\nBinary files /dev/null and b/a.ts differ\n', 1),
    },
  })
  expect(noticesOf(await fresh.diff(await fresh.track('/work/a.ts', 'xx')))).toEqual([
    'Binary file, code, 2 B. The diff shows text only.',
  ])
})

test('diff: a deleted binary file still has a size: the notice reads it from the commit that the diff starts at (n10 of the review of #289)', async () => {
  const t = world({
    git: {
      ...TRACKED,
      diff: res('diff --git a/a.ts b/a.ts\nBinary files a/a.ts and /dev/null differ\n'),
      'cat-file': res('2048\n'),
    },
    dirs: ['/work'],
  })
  const key = await t.track('/work/a.ts', 'x')
  delete t.w.files['/work/a.ts']
  const content = await t.diff(key)
  expect(content.blocks).toEqual([
    { kind: 'notice', text: 'The file is deleted: the diff shows what was removed.', tone: 'info' },
    { kind: 'notice', text: 'Binary file, code, 2.0 KB. The diff shows text only.', tone: 'info' },
  ])
  expect(t.subs().at(-1)).toBe(`cat-file -s ${SHA}:./a.ts`)
  // git cannot say: the notice has no size, and no more than that is lost.
  t.git['cat-file'] = res('', 128, 'fatal: path does not exist')
  expect(noticesOf(await t.diff(key)).at(-1)).toBe('Binary file, code. The diff shows text only.')
  // A size of 0 is a size, and a number below 0 is no size.
  t.git['cat-file'] = res('0\n')
  expect(noticesOf(await t.diff(key)).at(-1)).toBe('Binary file, code, 0 B. The diff shows text only.')
  t.git['cat-file'] = res('-1\n')
  expect(noticesOf(await t.diff(key)).at(-1)).toBe('Binary file, code. The diff shows text only.')
})

test('diff: a diff over 1,000,000 bytes, or one that the runner cut, is a notice and no content', async () => {
  const big = world({ git: { ...TRACKED, diff: res(`${CHANGED}+${'x'.repeat(1_000_001)}\n`) } })
  expect(noticesOf(await big.diff(await big.track('/work/a.ts', 'x')))).toEqual([
    'The diff is larger than 1,000,000 bytes: the preview does not draw it. Use git diff in a terminal.',
  ])
  const cut = world({ git: { ...TRACKED, diff: { ...res(CHANGED), isStdoutTruncated: true } } })
  expect(blocksOf(await cut.diff(await cut.track('/work/a.ts', 'x')))).toEqual(['notice'])
})

test('diff: the limit counts bytes, not characters: a diff of 400,000 characters of three bytes is over it, and one of 300,000 is not (n11)', async () => {
  const wide = (n: number) => `diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+${'世'.repeat(n)}\n`
  const over = world({ git: { ...TRACKED, diff: res(wide(400_000)) } })
  expect(noticesOf(await over.diff(await over.track('/work/a.ts', 'x')))).toEqual([
    'The diff is larger than 1,000,000 bytes: the preview does not draw it. Use git diff in a terminal.',
  ])
  const under = world({ git: { ...TRACKED, diff: res(wide(300_000)) } })
  expect(blocksOf(await under.diff(await under.track('/work/a.ts', 'x')))).toContain('diff')
})

test('diff: the limit is exact: a diff of 1,000,000 bytes is drawn, and one of 1,000,001 is not', async () => {
  const head = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+'
  const sized = (bytes: number) => `${head}${'x'.repeat(bytes - head.length - 1)}\n` // ASCII: a character is a byte
  expect(sized(1_000_000)).toHaveLength(1_000_000)
  const exact = world({ git: { ...TRACKED, diff: res(sized(1_000_000)) } })
  expect(blocksOf(await exact.diff(await exact.track('/work/a.ts', 'x')))).toContain('diff')
  const over = world({ git: { ...TRACKED, diff: res(sized(1_000_001)) } })
  expect(noticesOf(await over.diff(await over.track('/work/a.ts', 'x')))).toEqual([
    'The diff is larger than 1,000,000 bytes: the preview does not draw it. Use git diff in a terminal.',
  ])
})

test('diff: a long diff is cut at the border of a hunk within the caps of the preview, with a notice before the content that says how much shows', async () => {
  const hunk = (at: number) => `@@ -${at},0 +${at},3 @@\n+a\n+b\n+c\n`
  const many = Array.from({ length: 60 }, (_, i) => hunk(i * 10 + 1)).join('') // 60 hunks of 4 lines = 240 lines
  const long = world({
    git: { ...TRACKED, diff: res(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${many}`) },
    slice: { preview: { maxLines: 100, maxChars: 5000 } }, // the least that the config takes
  })
  const content = await long.diff(await long.track('/work/a.ts', 'x'))
  expect(blocksOf(content)).toEqual(['notice', 'diff'])
  expect(noticesOf(content)).toEqual(['Truncated: the first 100 of 240 lines of the diff (25 of 60 hunks).'])
  expect(content.subtitle).toContain('+180 -0') // the count is of the whole diff, not of what shows
  const shown = (content.blocks[1] as { source: string }).source
  expect(shown.split('\n').length - 1).toBe(100)
  expect(shown.endsWith('+c\n')).toBe(true) // the cut fell on the border of a hunk
  expect(shown.startsWith('@@ -1,0 +1,3 @@')).toBe(true)
})

test('diff: one hunk over the cap is cut inside, with a header for the lines it keeps, and the notice says that a hunk is cut', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `+line ${i}`).join('\n')
  const raw = `diff --git a/a.ts b/a.ts\n@@ -0,0 +1,300 @@\n${body}\n`
  const t = world({ git: { ...TRACKED, diff: res(raw) }, slice: { preview: { maxLines: 100, maxChars: 60000 } } })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  const shown = (content.blocks[1] as { source: string }).source
  expect(shown.split('\n')[0]).toBe('@@ -0,0 +1,99 @@')
  expect(noticesOf(content)).toEqual([
    'Truncated: the first 100 of 301 lines of the diff (1 of 1 hunk, the last one cut).',
  ])
})

test('diff: a line that does not fit the cap is cut short, and the notice says that and names the cap (G13, n12 of the review of #289)', async () => {
  // The least caps that the config takes: 100 lines and 5000 characters. The changed line is longer than the cap, after three context lines.
  const raw = `diff --git a/a.ts b/a.ts\n@@ -1,4 +1,4 @@\n a\n b\n c\n-${'x'.repeat(6000)}\n+${'y'.repeat(6000)}\n`
  const t = world({ git: { ...TRACKED, diff: res(raw) }, slice: { preview: { maxLines: 100, maxChars: 5000 } } })
  const cut = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(noticesOf(cut)).toEqual([
    'Truncated: the first 5 of 6 lines of the diff (1 of 1 hunk, the last one cut). A line is cut short to fit the cap of 5000 characters.',
  ])
  const source = (cut.blocks.at(-1) as { source: string }).source
  expect(source.length).toBeLessThanOrEqual(5000)
  expect(source.split('\n')[4]?.startsWith('-xxx')).toBe(true) // the change shows, after its context
  expect(cut.subtitle).toContain('+1 -1') // the count is of the whole diff
})

test('diff: a file that became a link has two blocks of git for the one path, and the diff and its count have both (m5 of the review of #289)', async () => {
  const raw = [
    'diff --git a/a.ts b/a.ts',
    'deleted file mode 100644',
    '--- a/a.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-one',
    '-two',
    'diff --git a/a.ts b/a.ts',
    'new file mode 120000',
    '--- /dev/null',
    '+++ b/a.ts',
    '@@ -0,0 +1 @@',
    '+/etc/hosts',
    '\\ No newline at end of file',
    '',
  ].join('\n')
  const t = world({ git: { ...TRACKED, diff: res(raw) } })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.subtitle).toBe('code · diff · vs origin/HEAD @ 1efdf45 · +1 -2')
  expect(content.blocks).toEqual([
    {
      kind: 'diff',
      source: '@@ -1,2 +0,0 @@\n-one\n-two\n@@ -0,0 +1 @@\n+/etc/hosts\n\\ No newline at end of file\n',
      path: '/work/a.ts',
    },
  ])
})

test('diff: the secret rule comes first: the diff of a secret file is a notice and git is never run', async () => {
  const t = world({ git: TRACKED })
  const content = await t.diff(await t.track('/work/.env', 'TOP-SECRET=1'))
  expect(noticesOf(content)).toEqual([
    'A secret file: the path matches the secret rule (trackers.file.secretPaths adds more). The preview never reads it.',
  ])
  expect(t.calls).toEqual([])
  expect(JSON.stringify(content)).not.toContain('TOP-SECRET')
})

test('diff: a folder and a special file are a notice and git is not run; a mode that no file has is a notice too', async () => {
  const t = world({ git: TRACKED })
  const dir = await t.track('/work/dir', 'x')
  const stat = t.w.ports.fs.stat
  t.w.ports.fs.stat = async (path, opts): Promise<FsStat | null> => {
    const real = await stat(path, opts)
    return real !== null && path === '/work/dir' ? { ...real, kind: 'dir' } : real
  }
  expect(noticesOf(await t.diff(dir))).toEqual(['A folder, not a file.'])
  const plain = await t.track('/work/a.ts', 'x')
  expect(noticesOf(await t.m.loadPreview(t.w.ports, 'file', plain, 'detail'))).toEqual([
    'This mode is not available for a file.',
  ])
  expect(t.calls).toEqual([])
})

test('diff: git that fails on the diff gives its first line as a warning', async () => {
  const t = world({ git: { ...TRACKED, diff: res('', 128, 'fatal: bad object\nmore') } })
  const content = await t.diff(await t.track('/work/a.ts', 'x'))
  expect(content.blocks).toEqual([{ kind: 'notice', text: 'git diff failed: fatal: bad object', tone: 'warning' }])
})

test('diff: a path with a dash, a space or glob characters is one literal path after `--`', async () => {
  const t = world({ git: TRACKED })
  await t.diff(await t.track('/work/-n [x]*.ts', 'x'))
  const call = t.w.calls.filter(c => c[0] === 'git').at(-1) as string[]
  expect(call.slice(-2)).toEqual(['--', '-n [x]*.ts'])
  expect(call).toContain('--literal-pathspecs')
})

test('diff: the view before and after a diff reads the file with head and runs no git of its own; git ran for the diff and the probe only', async () => {
  const t = world({ git: TRACKED })
  const key = await t.track('/work/a.ts', 'one\n')
  const code = { kind: 'code', source: 'one\n', path: '/work/a.ts', startLine: 1 }
  const first = await t.m.loadPreview(t.w.ports, 'file', key, 'view')
  expect(first.blocks).toEqual([code])
  expect(t.calls).toEqual([]) // the view runs no git
  const diff = await t.diff(key)
  const git = t.calls.length
  expect(diff.blocks.map(b => b.kind)).toEqual(['diff'])
  const again = await t.m.loadPreview(t.w.ports, 'file', key, 'view')
  expect(again.blocks).toEqual([code])
  expect(t.calls).toHaveLength(git) // the second view ran no git either: the probe waits for the clock
  expect(t.w.calls.filter(c => c[0] === 'head')).toEqual([
    ['head', '-c', HEAD_BYTES, '--', '/work/a.ts'],
    ['head', '-c', HEAD_BYTES, '--', '/work/a.ts'],
  ])
})

// `/track clean` for worktrees (issue #122): the auto tracker plans `git worktree remove <path>` for each removed child
// that this run has a proof for, and applies it one path at a time after `--yes worktrees`, only when git itself still lists
// the record as prunable (its directory is gone). `git worktree prune` never runs: it takes no path and would clear every
// prunable record of the repo. The world is the pane world over fake ports; `run` answers like git, and nothing touches a
// real repo.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import { autoCleanup } from '../trackers/auto/clean'
import { AUTO_DEFAULTS } from '../trackers/auto/config'
import type { AutoState, WorktreeProof, WorktreeRow } from '../trackers/auto/types'
import { noDockerIssue, proc, setProcesses } from './fixtures/hide-world'
import { NOW, paneWorld, WORLD_AUTO, WORLD_SNAPSHOT } from './fixtures/pane-world'

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string, exitCode = 128): RunResult => ({ exitCode, stdout: '', stderr })

const OLD = '/work/old-wt'
const proofOf = (path: string, f: Partial<WorktreeProof> = {}): WorktreeProof => ({
  path,
  origin: 'agent',
  provenAt: 1,
  removedAt: NOW - 1000,
  ...f,
})
/** A removed child whose record git still lists as prunable: the only removed row that a clean step can remove. */
const removedRow = (path: string, f: Partial<WorktreeRow> = {}): WorktreeRow => ({
  id: `wt:${path}`,
  path,
  name: path.split('/').pop() ?? path,
  branch: 'b',
  detached: false,
  state: 'removed',
  prunable: true,
  depth: 1,
  ...f,
})
/** A removed child that git has no record of at all (it was removed with `git worktree remove`): nothing is left to clean. */
const recordlessRow = (path: string): WorktreeRow => {
  const row = removedRow(path)
  delete row.prunable
  return row
}

/** `git worktree list --porcelain` for the main tree and these records: `[path, flags]`, flags are the extra lines. */
const porcelain = (...records: [string, string[]?][]): string =>
  [['/work', ['branch refs/heads/main']] as [string, string[]], ...records]
    .map(([path, more = []]) => ['worktree ' + path, ...more].join('\n'))
    .join('\n\n') + '\n'
const PRUNABLE = ['branch refs/heads/b', 'prunable gitdir file points to non-existent location']

async function treeWorld(
  o: {
    proofs?: WorktreeProof[]
    rows?: WorktreeRow[]
    list?: string
    git?: (argv: string[]) => RunResult | Promise<RunResult>
  } = {},
) {
  const t = await paneWorld()
  noDockerIssue(t)
  const rows = o.rows ?? [removedRow(OLD)]
  const snapshot = { ...WORLD_SNAPSHOT, worktrees: [WORLD_SNAPSHOT.worktrees[0]!, ...rows] }
  t.w.state.set('auto', { ...WORLD_AUTO, worktrees: o.proofs ?? [proofOf(OLD)], snapshot } as unknown as Json)
  const list = o.list ?? porcelain([OLD, PRUNABLE])
  t.w.run = async argv =>
    argv[0] === 'git' ? await (o.git?.(argv) ?? (argv[2] === 'list' ? ok(list) : ok())) : fail('unexpected call')
  const run = (args: string) => t.m.track(t.w.ports, args)
  const gits = () => t.w.calls.filter(c => c[0] === 'git')
  const removes = () => gits().filter(c => c[1] === 'worktree' && c[2] === 'remove')
  const log = () => (t.w.store.get('v2:log') ?? []) as unknown as { id: string; outcome: string; kind: string }[]
  return { ...t, run, gits, removes, log }
}

// ---------------------------------------------------------------- the plan

test('the plan lists a removed child that has a proof, by its path', async () => {
  const t = await treeWorld()
  const text = (await t.run('clean')).text
  expect(text).toContain(`Worktrees (apply with /track clean --yes worktrees)\n  ${OLD}: remove record\n`)
})

test('the plan skips a live child, the root and a removed row with no proof', async () => {
  const t = await treeWorld({
    rows: [removedRow(OLD), removedRow('/work/no-proof'), removedRow('/work/live', { state: 'live' })],
  })
  const text = (await t.run('clean')).text
  expect(text).toContain(`  ${OLD}: remove record`)
  expect(text).not.toContain('no-proof')
  expect(text).not.toContain('/work/live')
  expect(text).not.toContain('  /work:')
})

test('a removed row with no git record is not planned: no step, no git, no log entry, however often --yes runs', async () => {
  const t = await treeWorld({ rows: [recordlessRow(OLD)], list: porcelain() })
  expect((await t.run('clean')).text).not.toContain(OLD)
  for (let i = 0; i < 2; i++) {
    await t.run('clean --yes worktrees')
    expect(t.gits()).toEqual([])
    expect(t.log()).toEqual([])
  }
})

test('a removed row with a prunable record is planned, and one with no record next to it is not', async () => {
  const gone = '/work/gone'
  const t = await treeWorld({
    proofs: [proofOf(OLD), proofOf(gone)],
    rows: [removedRow(OLD), recordlessRow(gone)],
  })
  const text = (await t.run('clean')).text
  expect(text).toContain(`  ${OLD}: remove record`)
  expect(text).not.toContain(gone)
})

test('a dry run runs no process, not even git', async () => {
  const t = await treeWorld()
  const before = t.w.calls.length
  await t.run('clean')
  expect(t.w.calls).toHaveLength(before)
})

test('when the last round could not run git, every step is skipped: git failed: <error>, and apply runs no git', async () => {
  const t = await treeWorld()
  const auto = t.w.state.get('auto') as unknown as { snapshot: { git: unknown } }
  t.w.state.set('auto', {
    ...auto,
    snapshot: { ...auto.snapshot, git: { ok: false, at: NOW, error: 'spawn git ENOENT' } },
  } as unknown as Json)
  expect((await t.run('clean')).text).toContain(`  ${OLD}: skipped: git failed: spawn git ENOENT`)
  await t.run('clean --yes worktrees')
  expect(t.gits()).toEqual([])
  expect(t.log()).toEqual([]) // never tried
})

// ---------------------------------------------------------------- the apply

test('--yes worktrees runs git worktree remove <path> once, by argument vector, and never prune', async () => {
  const t = await treeWorld()
  const text = (await t.run('clean --yes worktrees')).text
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', OLD]])
  expect(t.gits().some(c => c.includes('prune'))).toBe(false)
  expect(t.gits().some(c => c.includes('--force') || c.includes('-f'))).toBe(false)
  expect(text).toContain(`  ${OLD}: done`)
  expect(t.log()).toEqual([
    { at: NOW, by: 'manual', kind: 'worktrees', id: `wt:${OLD}`, action: 'remove-record', outcome: 'done' },
  ])
})

test('git runs in the root of the session, with a timeout', async () => {
  const t = await treeWorld()
  await t.run('clean --yes worktrees')
  const removeAt = t.w.calls.findIndex(c => c[2] === 'remove')
  expect(t.w.callOpts[removeAt]?.cwd).toBe('/work')
  expect(t.w.callOpts[removeAt]?.timeoutMs).toBeGreaterThan(0)
})

test('a record that git lists as live is never removed: its directory is there', async () => {
  const t = await treeWorld({ list: porcelain([OLD, ['branch refs/heads/b']]) })
  const text = (await t.run('clean --yes worktrees')).text
  expect(t.removes()).toEqual([])
  expect(text).toContain(`  ${OLD}: skipped: the worktree is live`)
  expect(t.log().map(e => e.outcome)).toEqual(['skipped: the worktree is live'])
})

// Git never prints `prunable` for a locked record: a locked worktree is not pruned, so the record that the plan saw as
// prunable and that a person locked since reads `locked` and nothing else (study of #49, part 2, S3 run 2). The lock is
// checked before the prunable line, so its reason is the one that shows.
test('a record locked since the last round is skipped with the lock reason, and nothing is removed', async () => {
  const t = await treeWorld({ list: porcelain([OLD, ['branch refs/heads/b', 'locked on a usb stick']]) })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${OLD}: skipped: locked: on a usb stick`)
  expect(t.removes()).toEqual([])
  const bare = await treeWorld({ list: porcelain([OLD, ['branch refs/heads/b', 'locked']]) })
  expect((await bare.run('clean --yes worktrees')).text).toContain(`  ${OLD}: skipped: locked\n`)
  expect(bare.removes()).toEqual([])
})

test('a locked record is skipped even when a list shows it prunable too', async () => {
  const t = await treeWorld({ list: porcelain([OLD, [...PRUNABLE, 'locked on a usb stick']]) })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${OLD}: skipped: locked: on a usb stick`)
  expect(t.removes()).toEqual([])
})

test('a record that git no longer lists is skipped: nothing is left to remove', async () => {
  const t = await treeWorld({ list: porcelain() })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${OLD}: skipped: git has no record of it`)
  expect(t.removes()).toEqual([])
})

test('a child at the root path of the session is planned as skipped, and git never hears of it', async () => {
  const t = await treeWorld({
    proofs: [proofOf('/work')],
    rows: [removedRow('/work')],
    list: porcelain(['/work', PRUNABLE]),
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain('  /work: skipped: the root of the session')
  expect(t.gits()).toEqual([])
})

test('a git remove that fails is skipped: <first line of stderr>, and the next path is still tried, one at a time', async () => {
  const A = '/work/a'
  const B = '/work/b'
  const t = await treeWorld({
    proofs: [proofOf(A), proofOf(B)],
    rows: [removedRow(A), removedRow(B)],
    list: porcelain([A, PRUNABLE], [B, PRUNABLE]),
    git: argv =>
      argv[2] === 'list'
        ? ok(porcelain([A, PRUNABLE], [B, PRUNABLE]))
        : argv[3] === A
          ? fail("fatal: '/work/a' contains modified or untracked files, use --force to delete it\nsecond line")
          : ok(),
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(t.removes()).toEqual([
    ['git', 'worktree', 'remove', A],
    ['git', 'worktree', 'remove', B],
  ])
  expect(text).toContain(
    `  ${A}: skipped: fatal: '/work/a' contains modified or untracked files, use --force to delete it\n`,
  )
  expect(text).toContain(`  ${B}: done`)
  expect(text).not.toContain('second line')
})

// The snapshot is the plan's only source and a round rewrites it, so the row is cleared by the apply itself: until the
// next round, a second --yes would list the git records again and log one more no-op entry.
test('after a removal the row is no longer planned: a second --yes runs no git and adds no log entry', async () => {
  const t = await treeWorld()
  await t.run('clean --yes worktrees')
  expect(t.log().map(e => e.outcome)).toEqual(['done'])
  const gitsBefore = t.gits().length
  expect((await t.run('clean')).text).not.toContain(OLD)
  await t.run('clean --yes worktrees')
  expect(t.gits()).toHaveLength(gitsBefore)
  expect(t.log().map(e => e.outcome)).toEqual(['done'])
  const auto = t.w.state.get('auto') as unknown as { snapshot: { worktrees: WorktreeRow[] } }
  expect(auto.snapshot.worktrees.find(r => r.id === `wt:${OLD}`)).toMatchObject({ state: 'removed' }) // still a removed row
  expect(auto.snapshot.worktrees.find(r => r.id === `wt:${OLD}`)?.prunable).toBeUndefined()
})

test('a record that vanished since the last round is tried once: the row is cleared, and the next --yes logs nothing', async () => {
  const t = await treeWorld({ list: porcelain() })
  await t.run('clean --yes worktrees')
  expect(t.log().map(e => e.outcome)).toEqual(['skipped: git has no record of it'])
  await t.run('clean --yes worktrees')
  expect(t.log()).toHaveLength(1)
})

test('a row that git refused to remove keeps its mark: it is planned again', async () => {
  const t = await treeWorld({
    git: argv => (argv[2] === 'list' ? ok(porcelain([OLD, PRUNABLE])) : fail('fatal: busy')),
  })
  await t.run('clean --yes worktrees')
  expect((await t.run('clean')).text).toContain(`  ${OLD}: remove record`)
})

// A proof can keep a path that is a symlink alias of the path git lists. The round then matches the record by branch (spec
// A4), so the row is marked prunable. The recheck must find that same record, and remove the path git lists.
const ALIAS = '/private/work/old-wt'

test('a proof matched by branch (its recorded path is a symlink alias) is removed at the path git lists', async () => {
  const t = await treeWorld({
    proofs: [proofOf(ALIAS, { branch: 'b' })],
    rows: [removedRow(ALIAS)],
    list: porcelain([OLD, PRUNABLE]),
  })
  expect((await t.run('clean')).text).toContain(`  ${ALIAS}: remove record`)
  const text = (await t.run('clean --yes worktrees')).text
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', OLD]]) // the path of the record, not the alias
  expect(text).toContain(`  ${ALIAS}: done`)
  expect(t.log()).toEqual([
    { at: NOW, by: 'manual', kind: 'worktrees', id: `wt:${ALIAS}`, action: 'remove-record', outcome: 'done' },
  ])
  // The row is cleared like any removed row: a second --yes has no step and runs no more git.
  const gitsBefore = t.gits().length
  expect((await t.run('clean')).text).not.toContain(ALIAS)
  await t.run('clean --yes worktrees')
  expect(t.gits()).toHaveLength(gitsBefore)
  expect(t.log()).toHaveLength(1)
})

test('a proof matched by branch keeps every guard: a live or locked record is never removed', async () => {
  const live = await treeWorld({
    proofs: [proofOf(ALIAS, { branch: 'b' })],
    rows: [removedRow(ALIAS)],
    list: porcelain([OLD, ['branch refs/heads/b']]),
  })
  expect((await live.run('clean --yes worktrees')).text).toContain(`  ${ALIAS}: skipped: the worktree is live`)
  expect(live.removes()).toEqual([])
  const locked = await treeWorld({
    proofs: [proofOf(ALIAS, { branch: 'b' })],
    rows: [removedRow(ALIAS)],
    list: porcelain([OLD, [...PRUNABLE, 'locked on a usb stick']]),
  })
  expect((await locked.run('clean --yes worktrees')).text).toContain(`  ${ALIAS}: skipped: locked: on a usb stick`)
  expect(locked.removes()).toEqual([])
})

// The owner of a proof is gone, and its branch is carried by a record of someone else: a manual worktree that reuses the
// branch. A symlink alias changes the start of a path and never its last segments, so a record somewhere else is not the
// alias of the proof, and `git worktree remove` never hears of it.
test('a record of the same branch at another path is not the proof (no symlink alias): nothing is removed', async () => {
  const manual = '/home/me/manual-checkout'
  const t = await treeWorld({
    proofs: [proofOf(OLD, { branch: 'b' })],
    rows: [removedRow(OLD)],
    list: porcelain([manual, PRUNABLE]),
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(t.removes()).toEqual([])
  expect(text).toContain(`  ${OLD}: skipped: git has no record of it`)
})

test('a record of the same branch under the same folder name, but a different path, is not the proof either', async () => {
  const t = await treeWorld({
    proofs: [proofOf(OLD, { branch: 'b' })],
    rows: [removedRow(OLD)],
    list: porcelain(['/work/other/old-wt', PRUNABLE]), // same leaf name, other parent folder
  })
  await t.run('clean --yes worktrees')
  expect(t.removes()).toEqual([])
})

test('a branch that no record carries is not a match: git has no record of it, and nothing is removed', async () => {
  const t = await treeWorld({
    proofs: [proofOf(ALIAS, { branch: 'other' })],
    rows: [removedRow(ALIAS)],
    list: porcelain([OLD, PRUNABLE]),
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${ALIAS}: skipped: git has no record of it`)
  expect(t.removes()).toEqual([])
})

test('a git remove that throws is skipped: git could not run: <message>, and the next path is still tried', async () => {
  const A = '/work/a'
  const B = '/work/b'
  const t = await treeWorld({
    proofs: [proofOf(A), proofOf(B)],
    rows: [removedRow(A), removedRow(B)],
    git: argv => {
      if (argv[2] === 'list') return ok(porcelain([A, PRUNABLE], [B, PRUNABLE]))
      if (argv[3] === A) throw new Error('timed out')
      return ok()
    },
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: skipped: git could not run: timed out`)
  expect(text).toContain(`  ${B}: done`)
  expect(t.removes()).toEqual([
    ['git', 'worktree', 'remove', A],
    ['git', 'worktree', 'remove', B],
  ])
  expect(t.log().map(e => e.outcome)).toEqual(['done', 'skipped: git could not run: timed out'])
})

test('git missing: worktrees are skipped and name the failure, and the other kinds still run', async () => {
  const t = await treeWorld({
    git: () => {
      throw new Error('spawn git ENOENT')
    },
  })
  setProcesses(t, [proc('task:t1', 'running', { name: 'sleep 9', taskId: 't1' })])
  const text = (await t.run('clean --yes tasks worktrees')).text
  expect(t.w.stops).toEqual(['t1'])
  expect(text).toContain('  sleep 9: done')
  expect(text).toContain(`  ${OLD}: skipped: git could not run: spawn git ENOENT`)
  // The log is newest first: the tracker that applied last (processes, order 80) comes first.
  expect(t.log().map(e => [e.kind, e.outcome])).toEqual([
    ['tasks', 'done'],
    ['worktrees', 'skipped: git could not run: spawn git ENOENT'],
  ])
})

test('a list that exits non-zero skips every step with the first line of stderr', async () => {
  const t = await treeWorld({ git: () => fail('fatal: not a git repository\nhint') })
  expect((await t.run('clean --yes worktrees')).text).toContain(
    `  ${OLD}: skipped: git failed: fatal: not a git repository`,
  )
  expect(t.removes()).toEqual([])
})

// ---------------------------------------------------------------- the apply on its own: the guards that do not rely on the plan

/** The apply over a hand-made context: the state it reads and the git it runs. */
function applyOf(auto: AutoState, git: (argv: string[]) => Promise<RunResult>) {
  let data: AutoState = auto
  const ctx = {
    data: {
      get: async () => data,
      update: async (fn: (cur: AutoState | undefined) => AutoState) => (data = fn(data)),
    },
    tools: { run: (_tool: string, argv: string[]) => git(argv) },
    config: { slice: () => AUTO_DEFAULTS },
    log: () => {},
  } as unknown as Parameters<typeof autoCleanup.apply>[0]
  const step = (path: string) =>
    ({ kind: 'worktrees', id: `wt:${path}`, label: path, action: 'remove-record' }) as const
  return (...paths: string[]) => autoCleanup.apply(ctx, paths.map(step))
}

/** A git that writes each argv to `calls` and answers `answer` to all of them. */
const recording =
  (calls: string[][], answer: RunResult) =>
  async (argv: string[]): Promise<RunResult> => {
    calls.push(argv)
    return answer
  }

const AUTO = (f: Partial<AutoState> = {}): AutoState => ({
  ...WORLD_AUTO,
  worktrees: [proofOf(OLD)],
  snapshot: null,
  ...f,
})

test('apply: a step with no proof is skipped and runs no git', async () => {
  const calls: string[][] = []
  const apply = applyOf(AUTO({ worktrees: [] }), recording(calls, ok()))
  expect(await apply(OLD)).toEqual([{ id: `wt:${OLD}`, outcome: 'skipped: no proof that this run made it' }])
  expect(calls).toEqual([])
})

test('apply: the root of the session and a session with no git root are never touched', async () => {
  const calls: string[][] = []
  const git = recording(calls, ok(porcelain(['/work', PRUNABLE])))
  const root = applyOf(AUTO({ worktrees: [proofOf('/work')] }), git)
  expect(await root('/work')).toEqual([{ id: 'wt:/work', outcome: 'skipped: the root of the session' }])
  const none = applyOf(AUTO({ root: null }), git)
  expect(await none(OLD)).toEqual([{ id: `wt:${OLD}`, outcome: 'skipped: no git root' }])
  expect(calls).toEqual([])
})

test('apply: the main worktree is never removed, even when a proof names its path', async () => {
  const calls: string[][] = []
  const main = '/elsewhere/main'
  const list = [`worktree ${main}`, 'prunable gone', '', 'worktree /work', 'branch refs/heads/x', ''].join('\n')
  const apply = applyOf(AUTO({ worktrees: [proofOf(main)] }), recording(calls, ok(list)))
  expect(await apply(main)).toEqual([{ id: `wt:${main}`, outcome: 'skipped: the main worktree' }])
  expect(calls.filter(c => c[1] === 'worktree' && c[2] === 'remove')).toEqual([])
})

test('apply: the list is read once for all steps, and each step is answered', async () => {
  const calls: string[][] = []
  const A = '/work/a'
  const B = '/work/b'
  const list = porcelain([A, PRUNABLE], [B, PRUNABLE])
  const apply = applyOf(AUTO({ worktrees: [proofOf(A), proofOf(B)] }), recording(calls, ok(list)))
  expect(await apply(A, B)).toEqual([
    { id: `wt:${A}`, outcome: 'done' },
    { id: `wt:${B}`, outcome: 'done' },
  ])
  expect(calls.map(c => c.slice(1).join(' '))).toEqual([
    'worktree list --porcelain',
    `worktree remove ${A}`,
    `worktree remove ${B}`,
  ])
})

test('apply: a record that a proof matched by path is not taken again by the branch of another proof', async () => {
  const calls: string[][] = []
  // Both proofs carry branch b. OLD owns its record by path; ALIAS has none, and may not take the record of OLD.
  const apply = applyOf(
    AUTO({ worktrees: [proofOf(ALIAS, { branch: 'b' }), proofOf(OLD, { branch: 'b' })] }),
    recording(calls, ok(porcelain([OLD, PRUNABLE]))),
  )
  expect(await apply(ALIAS, OLD)).toEqual([
    { id: `wt:${ALIAS}`, outcome: 'skipped: git has no record of it' },
    { id: `wt:${OLD}`, outcome: 'done' },
  ])
  expect(calls.filter(c => c[2] === 'remove')).toEqual([['git', 'worktree', 'remove', OLD]]) // once, for its owner
})

test('apply: the branch of the main worktree never matches a proof, so the main worktree is never removed', async () => {
  const calls: string[][] = []
  const list = [
    'worktree /elsewhere/main',
    'branch refs/heads/b',
    'prunable gone',
    '',
    'worktree /work',
    'branch refs/heads/x',
    '',
  ].join('\n')
  const apply = applyOf(AUTO({ worktrees: [proofOf(ALIAS, { branch: 'b' })] }), recording(calls, ok(list)))
  expect(await apply(ALIAS)).toEqual([{ id: `wt:${ALIAS}`, outcome: 'skipped: git has no record of it' }])
  expect(calls.filter(c => c[2] === 'remove')).toEqual([])
})

test('apply: the record of the session root is never removed, by path or by branch', async () => {
  const calls: string[][] = []
  const W = '/work/w'
  const list = porcelain([W, ['branch refs/heads/b', 'prunable gone']])
  const root = { cwd: `${W}/sub`, top: `${W}/sub`, at: 1 }
  const byPath = applyOf(AUTO({ root, worktrees: [proofOf(W)] }), recording(calls, ok(list)))
  expect(await byPath(W)).toEqual([{ id: `wt:${W}`, outcome: 'skipped: the root of the session' }])
  const byBranch = applyOf(AUTO({ root, worktrees: [proofOf(ALIAS, { branch: 'b' })] }), recording(calls, ok(list)))
  expect(await byBranch(ALIAS)).toEqual([{ id: `wt:${ALIAS}`, outcome: 'skipped: git has no record of it' }])
  expect(calls.filter(c => c[2] === 'remove')).toEqual([])
})

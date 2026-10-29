// `/track clean` for live worktrees (issue #123, PR 1): the auto tracker plans `git worktree remove <path>` for each live
// child that this run has a proof for, and applies it after `--yes worktrees` only when `destroyWorktrees` is on and every
// guard holds: not locked, not the cwd of the session, no running agent, no untracked or modified file, and every commit of
// `HEAD` reachable from a base ref. The world is the pane world over fake ports; `run` answers like git, and nothing
// touches a real repo. The removal of a git record of a gone folder is in clean-worktrees.test.ts.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import { autoCleanup } from '../trackers/auto/clean'
import { AUTO_DEFAULTS } from '../trackers/auto/config'
import type { AgentProof, AutoState, WorktreeProof, WorktreeRow } from '../trackers/auto/types'
import { draw, flat, noDockerIssue, proc, setProcesses } from './fixtures/hide-world'
import { storedLog } from './fixtures/log'
import { NOW, paneWorld, WORLD_AUTO, WORLD_SNAPSHOT } from './fixtures/pane-world'

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string, exitCode = 128): RunResult => ({ exitCode, stdout: '', stderr })

const WT = '/work/.claude/worktrees'
const LIVE = `${WT}/wf_ab12-3`
const SHA = 'a'.repeat(40)
const MAIN_SHA = 'b'.repeat(40)
const DEFAULT_REASON = 'claude agent wf_ab12-3 (pid 812 start 1793003)'

/** A workflow proof: the agent index 3 of the run `wf_ab12`, as the round proves it by the path. */
const proofOf = (path = LIVE, f: Partial<WorktreeProof> = {}): WorktreeProof => ({
  path,
  origin: 'workflow',
  runId: 'wf_ab12',
  provenAt: 1,
  seenAt: 2,
  ...f,
})
const liveRow = (path = LIVE, f: Partial<WorktreeRow> = {}): WorktreeRow => ({
  id: `wt:${path}`,
  path,
  name: path.split('/').pop() ?? path,
  branch: 'b',
  detached: false,
  state: 'live',
  depth: 1,
  ...f,
})
const agentOf = (id: string, f: Partial<AgentProof> = {}): AgentProof => ({
  id,
  kind: 'subagent',
  label: id,
  spawnedAt: 1,
  ...f,
})

/** `git worktree list --porcelain` for the main tree (branch `main`) and these records: `[path, extra lines]`. */
const porcelain = (...records: [string, string[]?][]): string =>
  [['/work', [`HEAD ${MAIN_SHA}`, 'branch refs/heads/main']] as [string, string[]], ...records]
    .map(([path, more = []]) => ['worktree ' + path, ...more].join('\n'))
    .join('\n\n') + '\n'
/** A live record of a worktree on branch `b`, at `HEAD` `SHA`, with these extra lines (`locked …`, `prunable …`). */
const tree = (path = LIVE, ...more: string[]): [string, string[]] => [
  path,
  [`HEAD ${SHA}`, 'branch refs/heads/b', ...more],
]

type Opts = {
  proofs?: WorktreeProof[]
  rows?: WorktreeRow[]
  agents?: AgentProof[]
  /** The answer of `git worktree list --porcelain`, or a function that gives it at each call (a list that changes meanwhile). */
  list?: string | (() => string)
  /** `destroyWorktrees`. Default: on. */
  enabled?: boolean
  status?: (path: string) => RunResult | Promise<RunResult>
  revList?: (argv: string[]) => RunResult | Promise<RunResult>
  /** The answer of `git symbolic-ref -q refs/remotes/origin/HEAD`, or a function that gives it. Default: exit 1, no such ref. */
  originHead?: RunResult | (() => RunResult | Promise<RunResult>)
  /** The answer of `git -C <path> rev-parse --verify HEAD`: the sha of the tree just now. Default: `SHA`. */
  head?: (path: string) => RunResult | Promise<RunResult>
  /** The answer of `git rev-parse --verify -q <ref>^{commit}`: whether a base ref resolves. Default: `SHA`. */
  baseAlive?: (ref: string) => RunResult | Promise<RunResult>
  remove?: (path: string) => RunResult | Promise<RunResult>
  cwd?: string
}

async function liveWorld(o: Opts = {}) {
  const t = await paneWorld({ config: { auto: { destroyWorktrees: o.enabled ?? true } } })
  noDockerIssue(t)
  const rows = o.rows ?? [liveRow()]
  const snapshot = { ...WORLD_SNAPSHOT, worktrees: [WORLD_SNAPSHOT.worktrees[0]!, ...rows] }
  t.w.state.set('auto', {
    ...WORLD_AUTO,
    worktrees: o.proofs ?? [proofOf()],
    agents: o.agents ?? [],
    snapshot,
  } as unknown as Json)
  if (o.cwd !== undefined) t.w.session.cwd = o.cwd
  const list = o.list ?? porcelain(tree())
  const listNow = () => (typeof list === 'function' ? list() : list)
  t.w.run = async argv => {
    if (argv[0] !== 'git') return fail('unexpected call')
    const [, a, b] = argv
    if (a === 'worktree' && b === 'list') return ok(listNow())
    if (a === 'worktree' && b === 'remove') return (await o.remove?.(argv[3] ?? '')) ?? ok()
    if (a === '-C' && argv[3] === 'status') return (await o.status?.(argv[2] ?? '')) ?? ok('')
    if (a === '-C' && argv[3] === 'rev-parse') return (await o.head?.(argv[2] ?? '')) ?? ok(`${SHA}\n`)
    if (a === 'symbolic-ref')
      return (await (typeof o.originHead === 'function' ? o.originHead() : o.originHead)) ?? fail('', 1)
    if (a === 'rev-parse') return (await o.baseAlive?.(argv.at(-1)?.replace('^{commit}', '') ?? '')) ?? ok(`${SHA}\n`)
    if (a === 'rev-list') return (await o.revList?.(argv)) ?? ok('0\n')
    return fail(`unexpected git call: ${argv.join(' ')}`)
  }
  const run = (args: string) => t.m.track(t.w.ports, args)
  const gits = () => t.w.calls.filter(c => c[0] === 'git')
  const removes = () => gits().filter(c => c[1] === 'worktree' && c[2] === 'remove')
  const subs = () => gits().map(c => (c[1] === '-C' ? c[3] : c[1] === 'worktree' ? `worktree ${c[2]}` : c[1]))
  const log = () => storedLog(t.w.store)
  const row = (path = LIVE) => {
    const auto = t.w.state.get('auto') as unknown as { snapshot: { worktrees: WorktreeRow[] } }
    return auto.snapshot.worktrees.find(r => r.id === `wt:${path}`)
  }
  const proofs = () => (t.w.state.get('auto') as unknown as { worktrees: WorktreeProof[] }).worktrees
  return { ...t, run, gits, removes, subs, log, row, proofs }
}

const PLAN_WORD = 'remove worktree (if clean and merged; deletes ignored files)'

// ---------------------------------------------------------------- the plan

// R1 (worktree half): the switch is off by default, and the plan says so for each worktree it would otherwise remove.
test('with destroyWorktrees off a live child with a proof is skipped: not enabled, and --yes runs no git', async () => {
  const t = await liveWorld({ enabled: false })
  expect((await t.run('clean')).text).toContain(
    `Worktrees (apply with /track clean --yes worktrees)\n  ${LIVE}: skipped: not enabled\n`,
  )
  await t.run('clean --yes worktrees')
  expect(t.gits()).toEqual([])
  expect(t.log()).toEqual([]) // never tried
})

test('with destroyWorktrees on the same child is a remove worktree step, and the plan says that ignored files go too', async () => {
  const t = await liveWorld()
  expect((await t.run('clean')).text).toContain(
    `Worktrees (apply with /track clean --yes worktrees)\n  ${LIVE}: ${PLAN_WORD}\n`,
  )
})

test('the plan lists no live row without a proof, no root row and no removed row with no record', async () => {
  const t = await liveWorld({
    rows: [liveRow(`${WT}/no-proof`), liveRow(), { ...liveRow(`${WT}/gone`), state: 'removed' }],
    proofs: [proofOf(), proofOf(`${WT}/gone`)],
  })
  const text = (await t.run('clean')).text
  expect(text).toContain(`  ${LIVE}: ${PLAN_WORD}`)
  expect(text).not.toContain('no-proof')
  expect(text).not.toContain(`${WT}/gone`)
  expect(text).not.toContain('  /work:')
})

test('a dry run runs no process, not even git', async () => {
  const t = await liveWorld()
  const before = t.w.calls.length
  await t.run('clean')
  expect(t.w.calls).toHaveLength(before)
})

// R3 and R5: the pure guards show in the plan, each with its reason.
test('the plan skips the root, a locked child and a child with a running agent, each with its reason', async () => {
  const cases: [string, Opts, string][] = [
    ['the root of the session', { rows: [liveRow('/work')], proofs: [proofOf('/work')] }, 'the root of the session'],
    ['a lock with a reason', { rows: [liveRow(LIVE, { locked: DEFAULT_REASON })] }, `locked: ${DEFAULT_REASON}`],
    ['a lock with no reason', { rows: [liveRow(LIVE, { locked: '' })] }, 'locked'],
    [
      'an Agent-tool tree whose agent has not ended',
      { proofs: [proofOf(LIVE, { origin: 'agent', owner: 'a1' })], agents: [agentOf('a1')] },
      'an agent still works in it',
    ],
    [
      'an Agent-tool tree with no record of its agent',
      { proofs: [proofOf(LIVE, { origin: 'agent', owner: 'a1' })] },
      'no record of its agent',
    ],
    [
      'an Agent-tool tree with no owner at all',
      { proofs: [proofOf(LIVE, { origin: 'agent' })] },
      'no record of its agent',
    ],
    [
      'a workflow tree whose agent has this worktreePath and has not ended',
      { agents: [agentOf('w1', { kind: 'workflow', worktreePath: LIVE })] },
      'an agent still works in it',
    ],
    [
      'a workflow tree whose agent is the index in its path and has not ended',
      { agents: [agentOf('w1', { kind: 'workflow', workflow: { runId: 'wf_ab12', agentIndex: 3 } })] },
      'an agent still works in it',
    ],
    [
      'a tree that a subagent entered and that subagent has not ended',
      { proofs: [proofOf(LIVE, { origin: 'enter', owner: 'a1' })], agents: [agentOf('a1')] },
      'an agent still works in it',
    ],
  ]
  for (const [name, o, why] of cases) {
    const t = await liveWorld(o)
    expect((await t.run('clean')).text, name).toContain(`  ${o.rows?.[0]?.path ?? LIVE}: skipped: ${why}\n`)
    await t.run('clean --yes worktrees')
    expect(t.gits(), name).toEqual([])
  }
})

test('the plan keeps a tree whose agents all ended, and a tree that the main loop entered', async () => {
  const cases: [string, Opts][] = [
    [
      'an Agent-tool tree whose agent ended',
      { proofs: [proofOf(LIVE, { origin: 'agent', owner: 'a1' })], agents: [agentOf('a1', { endedAt: 5 })] },
    ],
    [
      'a workflow tree whose agents ended, and another run agent that works elsewhere',
      {
        agents: [
          agentOf('w1', { kind: 'workflow', worktreePath: LIVE, endedAt: 5 }),
          agentOf('w2', { kind: 'workflow', workflow: { runId: 'wf_ab12', agentIndex: 4 } }),
          agentOf('w3', { kind: 'workflow', workflow: { runId: 'wf_other', agentIndex: 3 } }),
        ],
      },
    ],
    ['a tree that the main loop entered', { proofs: [proofOf(LIVE, { origin: 'enter' })] }],
    [
      'a tree that an ended subagent entered',
      {
        proofs: [proofOf(LIVE, { origin: 'enter', owner: 'a1' })],
        agents: [agentOf('a1', { endedAt: 5 })],
      },
    ],
  ]
  for (const [name, o] of cases) {
    const t = await liveWorld(o)
    expect((await t.run('clean')).text, name).toContain(`  ${LIVE}: ${PLAN_WORD}\n`)
  }
})

test('a lock shows in the plan before the switch: a locked child is locked, not not enabled', async () => {
  const t = await liveWorld({ enabled: false, rows: [liveRow(LIVE, { locked: DEFAULT_REASON })] })
  expect((await t.run('clean')).text).toContain(`  ${LIVE}: skipped: locked: ${DEFAULT_REASON}\n`)
})

test('when the last round could not run git, a live child is skipped too: git failed: <error>', async () => {
  const t = await liveWorld()
  const auto = t.w.state.get('auto') as unknown as { snapshot: { git: unknown } }
  t.w.state.set('auto', {
    ...auto,
    snapshot: { ...auto.snapshot, git: { ok: false, at: NOW, error: 'spawn git ENOENT' } },
  } as unknown as Json)
  expect((await t.run('clean')).text).toContain(`  ${LIVE}: skipped: git failed: spawn git ENOENT`)
  await t.run('clean --yes worktrees')
  expect(t.gits()).toEqual([])
})

// ---------------------------------------------------------------- the apply: the removal

// R4: a clean tree with every commit on a base ref is removed by `git worktree remove <path>`, and the branch stays.
test('--yes worktrees removes a clean, merged tree: one git worktree remove <path>, never force, never a branch or prune', async () => {
  const t = await liveWorld()
  const text = (await t.run('clean --yes worktrees')).text
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', LIVE]])
  const argv = t.gits().flat()
  for (const never of ['--force', '-f', 'branch', '-d', '-D', 'prune']) expect(argv).not.toContain(never)
  expect(text).toContain(`  ${LIVE}: done`)
  expect(t.log()).toEqual([
    {
      at: NOW,
      by: 'manual',
      kind: 'worktrees',
      id: `wt:${LIVE}`,
      action: 'remove-worktree',
      outcome: 'done',
    },
  ])
})

test('the guards run in order, each by argument vector: list, list again, status, HEAD, base, rev-list, remove', async () => {
  const t = await liveWorld({ originHead: ok('refs/remotes/origin/main\n') })
  await t.run('clean --yes worktrees')
  expect(t.gits()).toEqual([
    ['git', 'worktree', 'list', '--porcelain'],
    ['git', 'worktree', 'list', '--porcelain'], // at the step of the tree: does it hold another worktree?
    ['git', '-C', LIVE, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    ['git', '-C', LIVE, 'rev-parse', '--verify', 'HEAD'],
    ['git', 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'],
    ['git', 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main^{commit}'],
    ['git', 'rev-list', '--count', SHA, '--not', 'refs/heads/main', 'refs/remotes/origin/main'],
    ['git', 'worktree', 'remove', LIVE],
  ])
})

// A removed tree is gone for the plan at once, as `removedRows` makes it for a record, so a second --yes has no step.
test('after a removal the row is removed at once: the next plan and a second --yes have no step, and log nothing', async () => {
  const t = await liveWorld()
  await t.run('clean --yes worktrees')
  expect(t.row()).toMatchObject({ state: 'removed' })
  expect(t.row()?.prunable).toBeUndefined()
  const gitsBefore = t.gits().length
  expect((await t.run('clean')).text).not.toContain(LIVE)
  await t.run('clean --yes worktrees')
  expect(t.gits()).toHaveLength(gitsBefore)
  expect(t.log().map(e => e.outcome)).toEqual(['done'])
})

// m4: the Worktrees section hides a removed row when its proof has no `removedAt` and a `--hide` came before. The apply
// turns the row `removed` at once, so it stamps the proof too, in the same write. A round keeps the stamp (A22).
test('a removed tree has removedAt at once, so a --hide before it does not hide it, and the pane lists it as removed', async () => {
  const t = await liveWorld()
  await t.run('clean --hide')
  expect(flat((await draw(t, 'worktrees')).rows)).toContain(`wt:${LIVE}`) // live: shown
  t.w.clock.now = NOW + 1000
  await t.run('clean --yes worktrees')
  expect(t.proofs().find(p => p.path === LIVE)?.removedAt).toBe(NOW + 1000)
  expect(flat((await draw(t, 'worktrees')).rows)).toContain(`wt:${LIVE}`)
  expect(t.row()).toMatchObject({ state: 'removed' })
})

test('a proof that already has removedAt keeps it, and the proof of a tree that was not removed gets none', async () => {
  const A = `${WT}/wf_ab12-1`
  const B = `${WT}/wf_ab12-2`
  const t = await liveWorld({
    proofs: [proofOf(A, { removedAt: 5 }), proofOf(B)],
    rows: [liveRow(A), liveRow(B)],
    list: porcelain(tree(A), tree(B)),
    status: path => ok(path === B ? '?? x\n' : ''),
  })
  t.w.clock.now = NOW + 1000
  await t.run('clean --yes worktrees')
  expect(t.proofs().find(p => p.path === A)?.removedAt).toBe(5)
  expect(t.proofs().find(p => p.path === B)?.removedAt).toBeUndefined()
})

test('a tree that git refused to remove keeps its row: it is planned again', async () => {
  const t = await liveWorld({ remove: () => fail('fatal: busy') })
  await t.run('clean --yes worktrees')
  expect(t.row()).toMatchObject({ state: 'live' })
  expect((await t.run('clean')).text).toContain(`  ${LIVE}: ${PLAN_WORD}`)
})

// G9: a remove deletes the whole tree, so it has its own timeout; every other git call keeps `gitTimeoutMs`.
test('git worktree remove runs with its own 120 s timeout, every other call with gitTimeoutMs, all in the root', async () => {
  const t = await liveWorld({ originHead: ok('refs/remotes/origin/main\n') })
  await t.run('clean --yes worktrees')
  const timeouts = t.w.calls.flatMap((c, i) =>
    c[0] === 'git' ? [[c[1] === 'worktree' && c[2] === 'remove', t.w.callOpts[i]] as const] : [],
  )
  const remove = timeouts.find(([isRemove]) => isRemove)?.[1]
  expect(remove?.timeoutMs).toBe(120000)
  expect(remove?.cwd).toBe('/work')
  const others = timeouts.filter(([isRemove]) => !isRemove)
  expect(others).toHaveLength(7) // list, list again, status, rev-parse HEAD, symbolic-ref, rev-parse of the base, rev-list
  for (const [, o] of others) expect(o?.timeoutMs).toBe(AUTO_DEFAULTS.gitTimeoutMs)
})

// m5: the mod maps git's English refusals, so every git call of the apply asks for English messages.
test('every git call of /track clean asks for English messages with LC_ALL=C, the remove included', async () => {
  const t = await liveWorld({ originHead: ok('refs/remotes/origin/main\n') })
  await t.run('clean --yes worktrees')
  const git = t.w.calls.flatMap((c, i) => (c[0] === 'git' ? [t.w.callOpts[i]] : []))
  expect(git).toHaveLength(8) // list, list again, status, rev-parse HEAD, symbolic-ref, rev-parse of the base, rev-list, remove
  for (const o of git) expect(o?.env).toEqual({ LC_ALL: 'C' })
})

test('a git remove that throws is skipped: git could not run: <message>', async () => {
  const t = await liveWorld({
    remove: () => {
      throw new Error('timed out')
    },
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: git could not run: timed out`)
})

// G14: git advises force. The lock and the status are checked before, so a refusal is a race, and the mod uses its own
// words for the known ones. The outcome and the audit log never carry git's advice.
const outcomesOf = async (o: Opts) => {
  const t = await liveWorld(o)
  const text = (await t.run('clean --yes worktrees')).text
  return { text, log: t.log().map(e => e.outcome) }
}

test('a lock that git names after the checks passed is `locked: <reason>`, in the outcome and in the log, with no -f -f', async () => {
  const r = await outcomesOf({
    remove: () =>
      fail(
        `fatal: cannot remove a locked working tree, lock reason: ${DEFAULT_REASON}\nuse 'remove -f -f' to override or unlock first`,
      ),
  })
  expect(r.text).toContain(`  ${LIVE}: skipped: locked: ${DEFAULT_REASON}\n`)
  expect(r.log).toEqual([`skipped: locked: ${DEFAULT_REASON}`])
  expect(r.text).not.toContain('-f -f')
})

test('a lock with no reason is `locked`, in the outcome and in the log, with no -f -f', async () => {
  const r = await outcomesOf({
    remove: () => fail("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"),
  })
  expect(r.text).toContain(`  ${LIVE}: skipped: locked\n`)
  expect(r.log).toEqual(['skipped: locked'])
  expect(r.text).not.toContain('-f -f')
})

test('a dirty tree that git names after the checks passed is `uncommitted or untracked files`, with no --force', async () => {
  for (const stderr of [
    `fatal: '${LIVE}' contains modified or untracked files, use --force to delete it`,
    `fatal: '${LIVE}' is dirty, use --force to delete it`,
  ]) {
    const r = await outcomesOf({ remove: () => fail(stderr) })
    expect(r.text, stderr).toContain(`  ${LIVE}: skipped: uncommitted or untracked files\n`)
    expect(r.log, stderr).toEqual(['skipped: uncommitted or untracked files'])
    expect(r.text, stderr).not.toContain('--force')
  }
})

test('any other refusal shows its first line only; no line at all is git exit <n>', async () => {
  const other = await outcomesOf({ remove: () => fail("fatal: '/work' is a main working tree\nsecond line") })
  expect(other.text).toContain(`  ${LIVE}: skipped: fatal: '/work' is a main working tree\n`)
  expect(other.text).not.toContain('second line')
  const silent = await outcomesOf({ remove: () => fail('', 1) })
  expect(silent.text).toContain(`  ${LIVE}: skipped: git exit 1\n`)
  expect(silent.log).toEqual(['skipped: git exit 1'])
})

test('a refusal in words the mod does not know that still advises force is cut: git refused to remove it', async () => {
  for (const stderr of [
    `Schwerwiegend: '${LIVE}' enthält geänderte oder nicht versionierte Dateien, benutzen Sie --force zum Löschen`,
    "fatal: gesperrt; benutze 'remove -f -f', um es zu ueberschreiben",
    'fatal: use -f to delete it',
  ]) {
    const r = await outcomesOf({ remove: () => fail(stderr) })
    expect(r.text, stderr).toContain(`  ${LIVE}: skipped: git refused to remove it\n`)
    expect(r.log, stderr).toEqual(['skipped: git refused to remove it'])
    expect(r.text, stderr).not.toContain('--force')
    expect(r.text, stderr).not.toContain('-f')
  }
})

test('a refusal that only has -f inside a word is shown as it is', async () => {
  const r = await outcomesOf({ remove: () => fail('fatal: cannot remove /work/self-fed, it is busy') })
  expect(r.text).toContain(`  ${LIVE}: skipped: fatal: cannot remove /work/self-fed, it is busy\n`)
})

// ---------------------------------------------------------------- the apply: the guards (R3)

// Each guard: the case, git's answer, and the outcome. A skipped tree never meets `git worktree remove`.
test('untracked or modified files skip the tree: uncommitted or untracked files, and no rev-list and no remove', async () => {
  for (const status of ['?? notes.txt\n', ' M src/a.ts\n', 'A  new.ts\n']) {
    const t = await liveWorld({ status: () => ok(status) })
    expect((await t.run('clean --yes worktrees')).text, status).toContain(
      `  ${LIVE}: skipped: uncommitted or untracked files\n`,
    )
    expect(t.removes(), status).toEqual([])
    expect(t.subs(), status).not.toContain('rev-list')
    expect(t.log().map(e => e.outcome)).toEqual(['skipped: uncommitted or untracked files'])
  }
})

// S2 of the study: with `status.showUntrackedFiles=no`, git's own guard lets an untracked file go. So the mod asks for all.
test('the status call asks for every untracked file and for submodules, whatever status.showUntrackedFiles says', async () => {
  const t = await liveWorld()
  await t.run('clean --yes worktrees')
  const status = t.gits().filter(c => c[1] === '-C' && c[3] === 'status')
  expect(status).toEqual([
    ['git', '-C', LIVE, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
  ])
})

test('a status call that fails or throws skips the tree and says why, and nothing is removed', async () => {
  const failed = await liveWorld({ status: () => fail('fatal: not a git repository\nhint') })
  expect((await failed.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: git failed: fatal: not a git repository\n`,
  )
  expect(failed.removes()).toEqual([])
  const threw = await liveWorld({
    status: () => {
      throw new Error('spawn git ENOENT')
    },
  })
  expect((await threw.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: git could not run: spawn git ENOENT\n`,
  )
  expect(threw.removes()).toEqual([])
})

test('a lock that came after the last round is skipped with its reason, and nothing is removed', async () => {
  const t = await liveWorld({ list: porcelain(tree(LIVE, `locked ${DEFAULT_REASON}`)) })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: locked: ${DEFAULT_REASON}\n`)
  expect(t.removes()).toEqual([])
  expect(t.subs()).not.toContain('status')
  const bare = await liveWorld({ list: porcelain(tree(LIVE, 'locked')) })
  expect((await bare.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: locked\n`)
})

test('a record that git lists as prunable has no folder left: skipped, the directory is gone, and nothing is removed', async () => {
  const t = await liveWorld({ list: porcelain(tree(LIVE, 'prunable gitdir file points to non-existent location')) })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: the directory is gone\n`)
  expect(t.removes()).toEqual([])
})

test('a record that git no longer lists is skipped, and its row is removed at once: no second try', async () => {
  const t = await liveWorld({ list: porcelain() })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: git has no record of it`)
  expect(t.row()).toMatchObject({ state: 'removed' })
  await t.run('clean --yes worktrees')
  expect(t.log().map(e => e.outcome)).toEqual(['skipped: git has no record of it'])
})

test('the record that holds the cwd of the session is never removed: the tree itself, or a folder inside it', async () => {
  for (const cwd of [LIVE, `${LIVE}/src/deep`]) {
    const t = await liveWorld({ cwd })
    expect((await t.run('clean --yes worktrees')).text, cwd).toContain(`  ${LIVE}: skipped: the session works in it\n`)
    expect(t.subs(), cwd).not.toContain('status')
    expect(t.removes(), cwd).toEqual([])
  }
})

test('a cwd in another tree, or in a folder that only starts with the same letters, does not hold the tree', async () => {
  for (const cwd of ['/work', `${LIVE}-other`, `${WT}/other`]) {
    const t = await liveWorld({ cwd })
    expect((await t.run('clean --yes worktrees')).text, cwd).toContain(`  ${LIVE}: done`)
  }
})

test('a cwd that cannot be read skips the tree: cannot read the session cwd', async () => {
  const t = await liveWorld()
  Object.defineProperty(t.w.session, 'cwd', {
    get() {
      throw new Error('no session')
    },
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: cannot read the session cwd\n`)
  expect(t.removes()).toEqual([])
  expect(t.subs()).not.toContain('status')
})

// G5, G6: the base refs are the branch of the main tree and the target of origin/HEAD, when each exists. A commit that a
// base ref holds is merged; a squash merge leaves commits off every base, so the tree is skipped with the base named.
test('a commit that no base ref holds skips the tree, and the reason names the count and the base', async () => {
  const two = await liveWorld({ revList: () => ok('2\n') })
  expect((await two.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: 2 commits not on refs/heads/main\n`,
  )
  expect(two.removes()).toEqual([])
  const one = await liveWorld({ revList: () => ok('1\n') })
  expect((await one.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: 1 commit not on refs/heads/main\n`,
  )
})

test('origin/HEAD is a base too when it resolves: both are passed to rev-list, and the reason names both', async () => {
  const t = await liveWorld({ originHead: ok('refs/remotes/origin/main\n'), revList: () => ok('3\n') })
  expect((await t.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: 3 commits not on refs/heads/main or refs/remotes/origin/main\n`,
  )
  expect(t.gits().find(c => c[1] === 'rev-list')).toEqual([
    'git',
    'rev-list',
    '--count',
    SHA,
    '--not',
    'refs/heads/main',
    'refs/remotes/origin/main',
  ])
})

test('a detached tree is checked by the HEAD sha of its record, not by a branch', async () => {
  const t = await liveWorld({
    list: porcelain([LIVE, [`HEAD ${SHA}`, 'detached']]),
    rows: [liveRow(LIVE, { detached: true })],
    revList: () => ok('1\n'),
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: 1 commit not on refs/heads/main\n`)
  expect(
    t
      .gits()
      .find(c => c[1] === 'rev-list')
      ?.slice(0, 4),
  ).toEqual(['git', 'rev-list', '--count', SHA])
  expect(t.removes()).toEqual([])
})

test('a record with no HEAD line is skipped: no HEAD, and no rev-list', async () => {
  const t = await liveWorld({ list: porcelain([LIVE, ['branch refs/heads/b']]) })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: no HEAD\n`)
  expect(t.subs()).not.toContain('rev-list')
  expect(t.removes()).toEqual([])
})

// M1: the list is read once for the whole apply, and a remove can take 120 s, so the sha of the list is as old as every
// step before it. A commit that a detached tree got meanwhile leaves the tree clean, and the old sha still counts as merged.
// So the sha is read from the tree itself at its own step, after the status, and that sha goes to rev-list.
const NEWER = 'c'.repeat(40)

test('the merged check reads the HEAD sha of the tree at its own step, not the one of the list: a newer commit is unmerged', async () => {
  const t = await liveWorld({
    list: porcelain([LIVE, [`HEAD ${SHA}`, 'detached']]),
    rows: [liveRow(LIVE, { detached: true })],
    head: () => ok(`${NEWER}\n`),
    revList: argv => ok(argv[3] === NEWER ? '1\n' : '0\n'), // the old sha counts as merged, the new one does not
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${LIVE}: skipped: 1 commit not on refs/heads/main\n`)
  expect(t.gits().find(c => c[1] === 'rev-list')).toEqual([
    'git',
    'rev-list',
    '--count',
    NEWER,
    '--not',
    'refs/heads/main',
  ])
  expect(t.removes()).toEqual([])
})

test('the sha is read after the status, so a commit that lands between the two counts as unmerged', async () => {
  const t = await liveWorld()
  await t.run('clean --yes worktrees')
  const order = t.gits().map(c => (c[1] === '-C' ? c[3] : c[1]))
  expect(order.indexOf('status')).toBeGreaterThan(-1)
  expect(order.indexOf('rev-parse')).toBeGreaterThan(order.indexOf('status'))
  expect(order.indexOf('rev-list')).toBeGreaterThan(order.indexOf('rev-parse'))
})

test('each tree gets its own sha at its own step, and a sha that is not on a base skips only that tree', async () => {
  const A = `${WT}/wf_ab12-1`
  const B = `${WT}/wf_ab12-2`
  const t = await liveWorld({
    proofs: [proofOf(A), proofOf(B)],
    rows: [liveRow(A), liveRow(B)],
    list: porcelain(tree(A), tree(B)),
    head: path => ok(`${path === B ? NEWER : SHA}\n`),
    revList: argv => ok(argv[3] === NEWER ? '2\n' : '0\n'),
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: done`)
  expect(text).toContain(`  ${B}: skipped: 2 commits not on refs/heads/main`)
  expect(t.gits().filter(c => c[1] === '-C' && c[3] === 'rev-parse')).toEqual([
    ['git', '-C', A, 'rev-parse', '--verify', 'HEAD'],
    ['git', '-C', B, 'rev-parse', '--verify', 'HEAD'],
  ])
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', A]])
})

test('a HEAD that git cannot read just now skips the tree: no HEAD, or git could not run, and no rev-list', async () => {
  const failed = await liveWorld({ head: () => fail('fatal: Needed a single revision') })
  expect((await failed.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: no HEAD\n`)
  const empty = await liveWorld({ head: () => ok('\n') })
  expect((await empty.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: no HEAD\n`)
  const threw = await liveWorld({
    head: () => {
      throw new Error('spawn git ENOENT')
    },
  })
  expect((await threw.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: git could not run: spawn git ENOENT\n`,
  )
  for (const t of [failed, empty, threw]) {
    expect(t.subs()).not.toContain('rev-list')
    expect(t.removes()).toEqual([])
  }
})

test('a main tree on a detached HEAD and no origin/HEAD leave no base: skipped: no base branch, and no rev-list', async () => {
  const list = [
    `worktree /work\nHEAD ${MAIN_SHA}\ndetached`,
    ['worktree ' + LIVE, `HEAD ${SHA}`, 'branch refs/heads/b'].join('\n'),
  ]
    .join('\n\n')
    .concat('\n')
  const t = await liveWorld({ list })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: no base branch\n`)
  expect(t.subs()).not.toContain('rev-list')
  expect(t.removes()).toEqual([])
})

test('a rev-list that fails or answers no number skips the tree', async () => {
  const failed = await liveWorld({ revList: () => fail('fatal: bad revision\nhint') })
  expect((await failed.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: git failed: fatal: bad revision\n`,
  )
  const odd = await liveWorld({ revList: () => ok('lots\n') })
  expect((await odd.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: git failed: unexpected answer`)
  const empty = await liveWorld({ revList: () => ok('') })
  expect((await empty.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: skipped: git failed: unexpected answer`)
  for (const t of [failed, odd, empty]) expect(t.removes()).toEqual([])
})

// m3: `symbolic-ref` can name a ref that is gone (the remote renamed its default branch and `fetch --prune` deleted the old
// one). That dead name is no base: the tree is judged by the main branch alone, not skipped with `git failed`.
test('an origin/HEAD whose target is gone is no base: the tree is judged by the main branch alone', async () => {
  const t = await liveWorld({
    originHead: ok('refs/remotes/origin/master\n'),
    baseAlive: ref => (ref === 'refs/remotes/origin/master' ? fail('', 1) : ok(`${SHA}\n`)),
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: done`)
  expect(t.gits().find(c => c[1] === 'rev-list')).toEqual([
    'git',
    'rev-list',
    '--count',
    SHA,
    '--not',
    'refs/heads/main',
  ])
  expect(t.gits().find(c => c[1] === 'rev-parse')).toEqual([
    'git',
    'rev-parse',
    '--verify',
    '-q',
    'refs/remotes/origin/master^{commit}',
  ])
})

test('a symbolic-ref that throws, or names nothing, leaves the main branch as the only base', async () => {
  const threw = await liveWorld({
    originHead: () => {
      throw new Error('timed out')
    },
  })
  const empty = await liveWorld({ originHead: ok('') })
  for (const t of [threw, empty]) {
    expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: done`)
    expect(
      t
        .gits()
        .find(c => c[1] === 'rev-list')
        ?.slice(4),
    ).toEqual(['--not', 'refs/heads/main'])
  }
})

test('a base check that throws is no base, and the tree is still judged by the other', async () => {
  const t = await liveWorld({
    originHead: ok('refs/remotes/origin/main\n'),
    baseAlive: () => {
      throw new Error('timed out')
    },
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: done`)
  expect(
    t
      .gits()
      .find(c => c[1] === 'rev-list')
      ?.slice(4),
  ).toEqual(['--not', 'refs/heads/main'])
})

test('an origin/HEAD that is the main branch is checked once and listed once', async () => {
  const t = await liveWorld({ originHead: ok('refs/heads/main\n') })
  await t.run('clean --yes worktrees')
  expect(t.gits().filter(c => c[1] === 'rev-parse' && c[2] === '--verify')).toEqual([])
  expect(
    t
      .gits()
      .find(c => c[1] === 'rev-list')
      ?.slice(4),
  ).toEqual(['--not', 'refs/heads/main'])
})

test('a rev-list that throws skips the tree: git could not run: <message>, and nothing is removed', async () => {
  const t = await liveWorld({
    revList: () => {
      throw new Error('spawn git ENOENT')
    },
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(
    `  ${LIVE}: skipped: git could not run: spawn git ENOENT\n`,
  )
  expect(t.removes()).toEqual([])
})

test('the base is read once for the whole apply, however many trees it checks', async () => {
  const A = `${WT}/wf_ab12-1`
  const B = `${WT}/wf_ab12-2`
  const t = await liveWorld({
    proofs: [proofOf(A), proofOf(B)],
    rows: [liveRow(A), liveRow(B)],
    list: porcelain(tree(A), tree(B)),
    originHead: ok('refs/remotes/origin/main\n'),
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: done`)
  expect(text).toContain(`  ${B}: done`)
  expect(t.gits().filter(c => c[1] === 'symbolic-ref')).toHaveLength(1)
  expect(t.gits().filter(c => c[1] === 'rev-parse' && c[2] === '--verify')).toHaveLength(1) // the base, not the trees
  expect(t.gits().filter(c => c[1] === '-C' && c[3] === 'rev-parse')).toHaveLength(2) // the HEAD of each tree
  expect(t.gits().filter(c => c[1] === 'worktree' && c[2] === 'list')).toHaveLength(3) // the apply, and the step of each tree
  expect(t.removes()).toEqual([
    ['git', 'worktree', 'remove', A],
    ['git', 'worktree', 'remove', B],
  ])
})

test('one tree that fails a guard never stops the next', async () => {
  const A = `${WT}/wf_ab12-1`
  const B = `${WT}/wf_ab12-2`
  const t = await liveWorld({
    proofs: [proofOf(A), proofOf(B)],
    rows: [liveRow(A), liveRow(B)],
    list: porcelain(tree(A), tree(B)),
    status: path => ok(path === A ? '?? x\n' : ''),
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: skipped: uncommitted or untracked files`)
  expect(text).toContain(`  ${B}: done`)
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', B]])
})

test('git missing: the live worktree is skipped and names the failure, and the other kinds still run', async () => {
  const t = await liveWorld()
  t.w.run = async () => {
    throw new Error('spawn git ENOENT')
  }
  setProcesses(t, [proc('task:t1', 'running', { name: 'sleep 9', taskId: 't1' })])
  const text = (await t.run('clean --yes tasks worktrees')).text
  expect(t.w.stops).toEqual(['t1'])
  expect(text).toContain('  sleep 9: done')
  expect(text).toContain(`  ${LIVE}: skipped: git could not run: spawn git ENOENT`)
})

test('one --yes handles a removed record and a live tree together: one git worktree list for the apply, one more at the step of the live tree', async () => {
  const OLD = `${WT}/wf_ab12-1`
  const t = await liveWorld({
    proofs: [proofOf(OLD), proofOf()],
    rows: [{ ...liveRow(OLD), state: 'removed', prunable: true }, liveRow()],
    list: porcelain([OLD, ['branch refs/heads/b', 'prunable gitdir file points to non-existent location']], tree()),
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${OLD}: done`)
  expect(text).toContain(`  ${LIVE}: done`)
  expect(t.gits().filter(c => c[1] === 'worktree' && c[2] === 'list')).toHaveLength(2) // the record needs no second list
  expect(t.removes()).toEqual([
    ['git', 'worktree', 'remove', OLD],
    ['git', 'worktree', 'remove', LIVE],
  ])
  // The log is newest first.
  expect(t.log().map(e => [e.action, e.outcome])).toEqual([
    ['remove-worktree', 'done'],
    ['remove-record', 'done'],
  ])
  // `--log` reads the same entries back through the real readLog, isEntry and logText (issue #213, the entries of issue #123).
  const printed = (await t.run('clean --log')).text ?? ''
  expect(printed).toContain('Clean log, newest first (2 entries):')
  expect(printed).toContain(`  manual  worktrees  wt:${LIVE}  remove-worktree  done`)
  expect(printed).toContain(`  manual  worktrees  wt:${OLD}  remove-record  done`)
})

test('the record removal keeps gitTimeoutMs: only the removal of a live tree has the long timeout', async () => {
  const OLD = '/work/old-wt'
  const t = await liveWorld({
    proofs: [proofOf(OLD)],
    rows: [{ ...liveRow(OLD), state: 'removed', prunable: true }],
    list: porcelain([OLD, ['branch refs/heads/b', 'prunable gitdir file points to non-existent location']]),
  })
  await t.run('clean --yes worktrees')
  const at = t.w.calls.findIndex(c => c[2] === 'remove')
  expect(t.w.callOpts[at]?.timeoutMs).toBe(AUTO_DEFAULTS.gitTimeoutMs)
})

// ---------------------------------------------------------------- the apply on its own: the guards that do not rely on the plan

type Extra = { agents?: AgentProof[]; destroyWorktrees?: boolean; cwd?: string | Error }

/**
 * The apply over a hand-made context: the state it reads, the switch, the cwd and the git it runs. `onRead` runs at each
 * read of the slot, and a throw there is a rejected read.
 */
function direct(
  auto: AutoState,
  o: Extra = {},
  git: (argv: string[]) => Promise<RunResult> = defaultGit,
  onRead: () => void = () => {},
) {
  const state: AutoState = { ...auto, ...(o.agents !== undefined ? { agents: o.agents } : {}) }
  const ctx = {
    data: {
      get: async () => {
        onRead()
        return state
      },
      update: async (fn: (cur: AutoState | undefined) => AutoState) => fn(state),
    },
    tools: { run: (_tool: string, argv: string[]) => git(argv) },
    config: { slice: () => ({ ...AUTO_DEFAULTS, destroyWorktrees: o.destroyWorktrees ?? true }) },
    session: {
      cwd: async () => {
        if (o.cwd instanceof Error) throw o.cwd
        return o.cwd ?? '/work'
      },
    },
    clock: { wall: () => NOW },
    log: () => {},
  } as unknown as Parameters<typeof autoCleanup.apply>[0]
  const step = (path: string) =>
    ({ kind: 'worktrees', id: `wt:${path}`, label: path, action: 'remove-worktree' }) as const
  return (...paths: string[]) => autoCleanup.apply(ctx, paths.map(step))
}

const defaultGit = async (argv: string[]): Promise<RunResult> => {
  if (argv[1] === 'worktree' && argv[2] === 'list') return ok(porcelain(tree()))
  if (argv[3] === 'rev-parse') return ok(`${SHA}\n`)
  if (argv[1] === 'rev-list') return ok('0\n')
  return ok()
}

/** A git that writes each argv to `calls` and answers like `answer`. */
const recording =
  (calls: string[][], answer: (argv: string[]) => RunResult = defaultAnswer) =>
  async (argv: string[]): Promise<RunResult> => {
    calls.push(argv)
    return answer(argv)
  }
/** The list of one clean live tree, the sha of its HEAD, a merged `rev-list`, and `ok` for the rest. */
const defaultAnswer = (argv: string[]): RunResult =>
  argv[2] === 'list'
    ? ok(porcelain(tree()))
    : argv[3] === 'rev-parse'
      ? ok(`${SHA}\n`)
      : argv[1] === 'rev-list'
        ? ok('0\n')
        : ok()

const AUTO = (f: Partial<AutoState> = {}): AutoState => ({
  ...WORLD_AUTO,
  worktrees: [proofOf()],
  snapshot: null,
  ...f,
})

test('apply: with the switch off a remove-worktree step is skipped: not enabled, and runs no git', async () => {
  const calls: string[][] = []
  const apply = direct(AUTO(), { destroyWorktrees: false }, recording(calls))
  expect(await apply(LIVE)).toEqual([{ id: `wt:${LIVE}`, outcome: 'skipped: not enabled' }])
  expect(calls).toEqual([])
})

test('apply: a step with no proof, the root and a session with no git root are never touched', async () => {
  const calls: string[][] = []
  const git = recording(calls, () => ok(porcelain(tree('/work'))))
  expect(await direct(AUTO({ worktrees: [] }), {}, git)(LIVE)).toEqual([
    { id: `wt:${LIVE}`, outcome: 'skipped: no proof that this run made it' },
  ])
  expect(await direct(AUTO({ worktrees: [proofOf('/work')] }), {}, git)('/work')).toEqual([
    { id: 'wt:/work', outcome: 'skipped: the root of the session' },
  ])
  expect(await direct(AUTO({ root: null }), {}, git)(LIVE)).toEqual([
    { id: `wt:${LIVE}`, outcome: 'skipped: no git root' },
  ])
  expect(calls).toEqual([])
})

test('apply: the main worktree is never removed, even when a proof names its path', async () => {
  const calls: string[][] = []
  const main = '/elsewhere/main'
  const list = [
    `worktree ${main}\nHEAD ${MAIN_SHA}\nbranch refs/heads/x`,
    'worktree /work\nbranch refs/heads/y',
    '',
  ].join('\n\n')
  const apply = direct(
    AUTO({ worktrees: [proofOf(main)] }),
    {},
    recording(calls, () => ok(list)),
  )
  expect(await apply(main)).toEqual([{ id: `wt:${main}`, outcome: 'skipped: the main worktree' }])
  expect(calls.filter(c => c[2] === 'remove')).toEqual([])
})

test('apply: an agent of the tree that runs at apply time is skipped, with no status call', async () => {
  const calls: string[][] = []
  const apply = direct(
    AUTO({ worktrees: [proofOf(LIVE, { origin: 'agent', owner: 'a1' })] }),
    { agents: [agentOf('a1')] },
    recording(calls),
  )
  expect(await apply(LIVE)).toEqual([{ id: `wt:${LIVE}`, outcome: 'skipped: an agent still works in it' }])
  expect(calls.map(c => c[1])).toEqual(['worktree'])
})

// Codex P1 on clean.ts:83. An agent is in the tree where the pane draws it: `agentLocations` (A6, first match wins), the one
// rule set of `trackAgents`. The plan knows only the facts that need no list (the path, the run and index, the owner), so
// these cases show in the result of `--yes`.
test('a running agent is in the tree where the pane draws it: its spawn cwd, its branch, or the place of an ended parent', async () => {
  const cases: [string, AgentProof[]][] = [
    ['a spawn cwd inside the tree', [agentOf('a1', { cwd: `${LIVE}/src/deep` })]],
    ['a spawn cwd that is the tree', [agentOf('a1', { cwd: LIVE })]],
    ['the branch that the tree has checked out', [agentOf('a1', { branch: 'b' })]],
    [
      'the place of its ended parent',
      [agentOf('p1', { worktreePath: LIVE, endedAt: 5 }), agentOf('c1', { parentId: 'p1', spawnedAt: 2 })],
    ],
    [
      'the place of its grandparent, over an ended parent that has none of its own',
      [
        agentOf('g1', { cwd: `${LIVE}/x`, endedAt: 5 }),
        agentOf('p1', { parentId: 'g1', spawnedAt: 2, endedAt: 5 }),
        agentOf('c1', { parentId: 'p1', spawnedAt: 3 }),
      ],
    ],
    ['a waiting teammate (no end yet)', [agentOf('a1', { cwd: `${LIVE}/src`, status: 'waiting', teammate: true })]],
  ]
  for (const [name, agents] of cases) {
    const t = await liveWorld({ agents })
    expect((await t.run('clean --yes worktrees')).text, name).toContain(
      `  ${LIVE}: skipped: an agent still works in it\n`,
    )
    expect(t.subs(), name).not.toContain('status')
    expect(t.removes(), name).toEqual([])
  }
})

test('an agent that is not in the tree does not hold it: ended, in another folder, or placed by its own cwd under a parent in the tree', async () => {
  const cases: [string, AgentProof[]][] = [
    ['an ended agent whose spawn cwd is in the tree', [agentOf('a1', { cwd: `${LIVE}/src`, endedAt: 5 })]],
    ['a running agent in the root', [agentOf('a1', { cwd: '/work' })]],
    ['a running agent in a folder that only starts with the same letters', [agentOf('a1', { cwd: `${LIVE}-other` })]],
    ['a running agent in another tree', [agentOf('a1', { cwd: `${WT}/other`, worktreePath: `${WT}/other` })]],
    [
      'a running child with its own cwd in the root, under a parent in the tree (its own place comes first)',
      [
        agentOf('p1', { worktreePath: LIVE, endedAt: 5 }),
        agentOf('c1', { parentId: 'p1', spawnedAt: 2, cwd: '/work' }),
      ],
    ],
    [
      'a running agent whose parent is in another tree',
      [agentOf('p1', { cwd: `${WT}/other`, endedAt: 5 }), agentOf('c1', { parentId: 'p1', spawnedAt: 2 })],
    ],
  ]
  for (const [name, agents] of cases) {
    const t = await liveWorld({ agents })
    expect((await t.run('clean --yes worktrees')).text, name).toContain(`  ${LIVE}: done`)
    expect(t.removes(), name).toEqual([['git', 'worktree', 'remove', LIVE]])
  }
})

// Codex P1 on clean.ts:384. One `--yes` reads the agent ledger at the check of each tree, as it reads the `HEAD` sha (M1):
// a remove can take 120 s, and the ledger moves while it runs. The first remove here is the one that moves it.
type Live = Awaited<ReturnType<typeof liveWorld>>
const TWO = () => {
  const A = `${WT}/wf_ab12-1`
  const B = `${WT}/wf_ab12-2`
  return {
    A,
    B,
    base: { proofs: [proofOf(A), proofOf(B)], rows: [liveRow(A), liveRow(B)], list: porcelain(tree(A), tree(B)) },
  }
}
/** Sets the agents of the ledger, as the pane would after an agent starts or ends. */
const setAgents = (t: Live, agents: AgentProof[]) =>
  t.w.state.set('auto', { ...(t.w.state.get('auto') as unknown as AutoState), agents } as unknown as Json)

test('an agent that starts in the second tree while the first is removed stops that removal: the ledger is read at each tree', async () => {
  const { A, B, base } = TWO()
  let t: Live | undefined
  t = await liveWorld({
    ...base,
    remove: path => {
      if (path === A && t) setAgents(t, [agentOf('a1', { worktreePath: B })])
      return ok()
    },
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: done`)
  expect(text).toContain(`  ${B}: skipped: an agent still works in it\n`)
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', A]])
})

test('the same for an agent that is placed by its cwd: it starts in the second tree during the first remove', async () => {
  const { A, B, base } = TWO()
  let t: Live | undefined
  t = await liveWorld({
    ...base,
    remove: path => {
      if (path === A && t) setAgents(t, [agentOf('a1', { cwd: `${B}/src` })])
      return ok()
    },
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${B}: skipped: an agent still works in it\n`)
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', A]])
})

test('an agent that ends in the second tree while the first is removed no longer stops it: a fresh read, not a latch', async () => {
  const { A, B, base } = TWO()
  let t: Live | undefined
  t = await liveWorld({
    ...base,
    agents: [agentOf('a1', { cwd: `${B}/src` })],
    remove: path => {
      if (path === A && t) setAgents(t, [agentOf('a1', { cwd: `${B}/src`, endedAt: 5 })])
      return ok()
    },
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: done`)
  expect(text).toContain(`  ${B}: done`)
  expect(t.removes()).toEqual([
    ['git', 'worktree', 'remove', A],
    ['git', 'worktree', 'remove', B],
  ])
})

test('the same for the cwd of the session: it moves into the second tree while the first is removed', async () => {
  const { A, B, base } = TWO()
  let t: Live | undefined
  t = await liveWorld({
    ...base,
    remove: path => {
      if (path === A && t) t.w.session.cwd = `${B}/src`
      return ok()
    },
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: done`)
  expect(text).toContain(`  ${B}: skipped: the session works in it\n`)
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', A]])
})

test('a ledger that cannot be read at the check skips the tree: cannot read the agents, and nothing is removed', async () => {
  const calls: string[][] = []
  let reads = 0
  const apply = direct(AUTO(), {}, recording(calls), () => {
    if (++reads > 1) throw new Error('gone') // the first read is the proof lookup; the second is the check of the tree
    return undefined
  })
  expect(await apply(LIVE)).toEqual([{ id: `wt:${LIVE}`, outcome: 'skipped: cannot read the agents' }])
  expect(calls.filter(c => c[2] === 'remove')).toEqual([])
  expect(calls.filter(c => c[1] === '-C')).toEqual([])
})

test('apply: a cwd that rejects is the safe side, and one that holds the tree is skipped', async () => {
  const calls: string[][] = []
  const git = recording(calls)
  expect(await direct(AUTO(), { cwd: new Error('gone') }, git)(LIVE)).toEqual([
    { id: `wt:${LIVE}`, outcome: 'skipped: cannot read the session cwd' },
  ])
  expect(await direct(AUTO(), { cwd: `${LIVE}/x` }, git)(LIVE)).toEqual([
    { id: `wt:${LIVE}`, outcome: 'skipped: the session works in it' },
  ])
  expect(calls.filter(c => c[2] === 'remove')).toEqual([])
})

test('apply: a symlink alias of the tree in the cwd of the session still holds it', async () => {
  const ALIAS = '/private/work/.claude/worktrees/wf_ab12-3'
  const apply = direct(AUTO({ worktrees: [proofOf(ALIAS, { branch: 'b' })] }), { cwd: `${ALIAS}/src` }, async argv =>
    argv[2] === 'list' ? ok(porcelain(tree())) : ok('0\n'),
  )
  expect(await apply(ALIAS)).toEqual([{ id: `wt:${ALIAS}`, outcome: 'skipped: the session works in it' }])
})

test('apply: a proof path that is a symlink alias removes the path that git lists, not the alias', async () => {
  const ALIAS = '/private/work/.claude/worktrees/wf_ab12-3'
  const calls: string[][] = []
  const apply = direct(AUTO({ worktrees: [proofOf(ALIAS, { branch: 'b' })] }), { cwd: '/work' }, recording(calls))
  expect(await apply(ALIAS)).toEqual([{ id: `wt:${ALIAS}`, outcome: 'done' }])
  expect(calls.filter(c => c[1] === '-C').map(c => [c[2], c[3]])).toEqual([
    [LIVE, 'status'],
    [LIVE, 'rev-parse'],
  ])
  expect(calls.filter(c => c[2] === 'remove')).toEqual([['git', 'worktree', 'remove', LIVE]])
})

// Codex P1 on clean.ts:282 (round 3). `git worktree remove` deletes the ignored files of a tree, and this repo keeps its
// worktrees under the ignored `.claude/worktrees/`. So a tree can hold another registered worktree, and removing the outer one
// deletes the inner one, also while an agent works in it, and leaves a stale registration. The rule: a tree that holds another
// registered worktree is never removed, with an agent in it or not. Git is asked for the list at the step of each tree.
const INNER = `${LIVE}/.claude/worktrees/inner`
/** A record of a worktree on its own branch `inner`, with these extra lines. */
const nested = (path = INNER, ...more: string[]): [string, string[]] => [
  path,
  [`HEAD ${SHA}`, 'branch refs/heads/inner', ...more],
]
const lists = (t: Live) => t.gits().filter(c => c[1] === 'worktree' && c[2] === 'list')

test('a tree that holds another registered worktree is skipped: holds the worktree <path>, with no status and no remove', async () => {
  const cases: [string, [string, string[]]][] = [
    ['a worktree in an ignored folder of the tree', nested(INNER)],
    ['a worktree deeper in the tree', nested(`${LIVE}/a/b/c/deep`)],
    ['a locked worktree in the tree', nested(INNER, 'locked claude agent wf_other-1 (pid 9 start 1)')],
    [
      'a worktree in the tree whose folder is gone: it is still registered',
      nested(INNER, 'prunable gitdir file points to non-existent location'),
    ],
    ['a bare record in the tree', [INNER, ['bare']]],
  ]
  for (const [name, record] of cases) {
    const t = await liveWorld({ list: porcelain(tree(), record) })
    expect((await t.run('clean --yes worktrees')).text, name).toContain(
      `  ${LIVE}: skipped: holds the worktree ${record[0]}\n`,
    )
    expect(t.subs(), name).not.toContain('status')
    expect(t.subs(), name).not.toContain('rev-list')
    expect(t.removes(), name).toEqual([])
    expect(
      t.log().map(e => e.outcome),
      name,
    ).toEqual([`skipped: holds the worktree ${record[0]}`])
    expect(t.row(), name).toMatchObject({ state: 'live' })
  }
})

test('an agent in the nested worktree does not make the outer tree removable: the outer tree holds a worktree, agent or not', async () => {
  const cases: [string, AgentProof[]][] = [
    ['no agent at all', []],
    ['an agent that has the nested worktree path', [agentOf('a1', { kind: 'workflow', worktreePath: INNER })]],
    ['an agent whose spawn cwd is in the nested worktree', [agentOf('a1', { cwd: `${INNER}/src` })]],
    ['an agent that has the branch of the nested worktree', [agentOf('a1', { branch: 'inner' })]],
    ['an agent that ended', [agentOf('a1', { worktreePath: INNER, endedAt: 5 })]],
  ]
  for (const [name, agents] of cases) {
    const t = await liveWorld({ agents, list: porcelain(tree(), nested()) })
    expect((await t.run('clean --yes worktrees')).text, name).toContain(
      `  ${LIVE}: skipped: holds the worktree ${INNER}\n`,
    )
    expect(t.removes(), name).toEqual([])
  }
})

test('a record that is not inside the tree does not hold it: the main tree, a sibling, a parent folder, and a folder that only starts with the same letters', async () => {
  const t = await liveWorld({
    list: porcelain(
      tree(),
      nested(`${LIVE}-other`),
      nested(`${WT}/wf_ab12-4`),
      nested('/work/.claude'),
      nested('/work/elsewhere'),
    ),
  })
  expect((await t.run('clean --yes worktrees')).text).toContain(`  ${LIVE}: done`)
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', LIVE]])
})

test('the list is read at the step of each tree: a worktree that appears in the second tree while the first is removed holds it', async () => {
  const { A, B, base } = TWO()
  const INSIDE_B = `${B}/.claude/worktrees/inner`
  let added = false
  const t = await liveWorld({
    ...base,
    list: () => porcelain(tree(A), tree(B), ...(added ? [nested(INSIDE_B)] : [])),
    remove: path => {
      if (path === A) added = true
      return ok()
    },
  })
  const text = (await t.run('clean --yes worktrees')).text
  expect(text).toContain(`  ${A}: done`)
  expect(text).toContain(`  ${B}: skipped: holds the worktree ${INSIDE_B}\n`)
  expect(t.removes()).toEqual([['git', 'worktree', 'remove', A]])
  expect(lists(t)).toHaveLength(3) // one for the apply, and one at the step of each tree
})

test('apply: a worktree inside the proof path (a symlink alias) or inside the path that git lists holds the tree', async () => {
  const ALIAS = '/private/work/.claude/worktrees/wf_ab12-3'
  for (const where of [`${ALIAS}/.claude/worktrees/inner`, INNER]) {
    const calls: string[][] = []
    const git = recording(calls, argv =>
      argv[2] === 'list' ? ok(porcelain(tree(), nested(where))) : defaultAnswer(argv),
    )
    const apply = direct(AUTO({ worktrees: [proofOf(ALIAS, { branch: 'b' })] }), { cwd: '/work' }, git)
    expect(await apply(ALIAS)).toEqual([{ id: `wt:${ALIAS}`, outcome: `skipped: holds the worktree ${where}` }])
    expect(calls.filter(c => c[2] === 'remove')).toEqual([])
  }
})

test('a list that cannot be read at the step skips the tree and says why: git failed, or git could not run, and nothing is removed', async () => {
  const cases: [string, (argv: string[]) => RunResult, string][] = [
    ['git fails', () => fail('fatal: not a git repository\nmore'), 'skipped: git failed: fatal: not a git repository'],
    [
      'git throws',
      () => {
        throw new Error('spawn git ENOENT')
      },
      'skipped: git could not run: spawn git ENOENT',
    ],
  ]
  for (const [name, second, outcome] of cases) {
    const calls: string[][] = []
    let seen = 0
    const apply = direct(
      AUTO(),
      {},
      recording(calls, argv => (argv[2] === 'list' && ++seen > 1 ? second(argv) : defaultAnswer(argv))),
    )
    expect(await apply(LIVE), name).toEqual([{ id: `wt:${LIVE}`, outcome }])
    expect(
      calls.filter(c => c[1] === '-C' || c[2] === 'remove'),
      name,
    ).toEqual([])
  }
})

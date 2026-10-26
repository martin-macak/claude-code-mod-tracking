// `/track clean` for worktrees: the cleanup of the auto tracker. It has two actions under the one kind `worktrees`.
//
// `remove-record` (issue #122): the plan lists each removed child worktree that this run has a proof for and whose record git
// still lists as prunable. `--yes worktrees` removes the git record of each, one path at a time, as
// `git worktree remove <path>` by argument vector. It is never `git worktree prune`: prune takes no path and clears every
// prunable record of the repo, the ones the mod does not own too (design study of #49, S3). `git worktree remove` also
// deletes the directory of a worktree that is still there, so this step runs only when git itself, asked just now, lists the
// record as prunable: its directory is gone.
//
// `remove-worktree` (issue #123): the plan lists each live child worktree that this run has a proof for. It is off until
// `trackers.auto.destroyWorktrees` is on (the plan says `skipped: not enabled`). `--yes worktrees` then removes the tree with
// `git worktree remove <path>`, and only when every guard holds, checked in this order just now: the root and the main tree,
// no lock, not the folder of the session (`session.cwd()`), no running agent of this run in it (named by the proof, or drawn
// in it by the rules of the Agents section: `agentWorksIn`), no other registered worktree inside the tree (`holdsOf`: git
// deletes the ignored files with the tree, and worktrees often sit in an ignored folder), no untracked or modified file
// (`status --untracked-files=all`, because git's own guard follows `status.showUntrackedFiles`), and every commit of `HEAD`
// reachable from a base ref (the branch of the main tree, and `origin/HEAD` when it is set and still resolves). The `HEAD`
// sha, the cwd of the session, the agent ledger and the list for the tree-in-tree check are read from the world at the step
// of each tree: the list of the apply is as old as every remove before this step, and a remove can run 120 s. A squash- or
// rebase-merged branch leaves commits off the base, so its tree is skipped. Git deletes the ignored files of the tree with
// it. The branch stays. Every git call runs with `LC_ALL=C`, so the words of a refusal are English in any locale.
//
// There is no `--force` and no `-f`, never a branch delete. A live, locked or main record is never removed by the first
// action, and the second never touches the root or the main tree.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design studies: issue #49, R14 and G12;
// issue #123, sections 5.4 and 5.6.

import type { CleanResult, CleanStep, Cleanup } from '../../core/interfaces/clean'
import type { RunResult } from '../../core/interfaces/ports'
import type { ViewContext } from '../../core/interfaces/view'
import {
  basename,
  findByPath,
  type GitWorktree,
  holds,
  locate,
  normPath,
  parsePorcelain,
  workflowWorktreeName,
} from '../../core/lib/porcelain'
import { firstLine, message } from '../../core/lib/text'
import { agentWorksIn } from './agents'
import type { AutoConfig } from './config'
import { worktreeId } from './ids'
import type { AgentProof, AutoState, WorktreeProof, WorktreeRow } from './types'
import { matchProofs } from './worktrees'

const ROOT = 'the root of the session'
const NOT_ENABLED = 'not enabled'
const AGENT_WORKS = 'an agent still works in it'
const NO_AGENT = 'no record of its agent'
const NO_LEDGER = 'cannot read the agents'
const NO_RECORD = 'skipped: git has no record of it'
const NO_FORCE = 'git refused to remove it'

/**
 * The timeout of the one `git worktree remove` of a live tree. The remove deletes the whole folder, so it can run far longer
 * than a status call, and a kill at `gitTimeoutMs` would leave a half-deleted tree (design study of #123, G9). The other
 * git calls, and the removal of a record, keep `gitTimeoutMs`.
 */
const REMOVE_TIMEOUT_MS = 120_000

/**
 * The environment of every git call: `LC_ALL=C` keeps git's messages in English, so `refusal()` matches under any locale (as
 * in `trackers/repos/tracker.ts`). `RunOpts.env` adds to the host environment, it does not replace it.
 */
const ENGLISH = { LC_ALL: 'C' } as const

/** The lock of a row as a plan reason: `locked`, or `locked: <reason>`. */
const lockText = (reason: string): string => (reason === '' ? 'locked' : `locked: ${reason}`)

/**
 * Whether an agent of this run still works in the tree of `proof`, as the state knows it (R5 of #123): the reason, or
 * `undefined`. Any agent that has not ended and was given this folder counts: by its `worktreePath`, or, for a workflow
 * tree (`<runId>-<agentIndex>`), by the run and the index. An Agent-tool tree needs the record of its agent, and that agent
 * must have ended. A tree that a subagent entered needs the same of that subagent. A tree that the main loop entered and a
 * workflow tree rely on the engine's lock and on the cwd of the session, which apply checks.
 */
function agentWorks(agents: readonly AgentProof[], proof: WorktreeProof): string | undefined {
  const path = normPath(proof.path)
  const here = agents.some(a => {
    if (a.endedAt !== undefined) return false
    if (a.worktreePath !== undefined && normPath(a.worktreePath) === path) return true
    return (
      proof.runId !== undefined &&
      a.workflow?.runId === proof.runId &&
      basename(path) === workflowWorktreeName(proof.runId, a.workflow.agentIndex)
    )
  })
  if (here) return AGENT_WORKS
  if (proof.owner === undefined) return proof.origin === 'agent' ? NO_AGENT : undefined
  const owner = agents.find(a => a.id === proof.owner)
  if (owner === undefined) return NO_AGENT
  return owner.endedAt === undefined ? AGENT_WORKS : undefined
}

/**
 * The steps of the plan, in the order of the rows. Pure: it runs nothing.
 *
 * A removed child row that this run has a proof for and whose record git still lists as prunable is a `remove-record` step.
 * A removed row with no record has nothing left to remove, so it is no step: a step would be tried, and so logged, on each
 * `--yes`. The root of the session is listed with its reason, and is never applied.
 *
 * A live child row that this run has a proof for is a `remove-worktree` step, with the first reason that fits: the root, a
 * failed git of the last round, a lock, a running agent, and last the switch. What needs git (status, merge state) shows
 * only in the result of `--yes`.
 */
function plan(ctx: Pick<ViewContext<AutoConfig, AutoState>, 'data' | 'config'>): CleanStep[] {
  const auto = ctx.data
  const snap = auto?.snapshot
  if (!auto || !snap) return []
  const proofs = new Map(auto.worktrees.map(p => [worktreeId(p.path), p]))
  const top = typeof auto.root?.top === 'string' ? normPath(auto.root.top) : undefined
  const gitFailed = snap.git.ok ? undefined : `git failed: ${snap.git.error ?? 'unknown error'}`
  const enabled = ctx.config.slice().destroyWorktrees
  const steps: CleanStep[] = []
  for (const r of snap.worktrees) {
    const proof = proofs.get(r.id)
    if (r.depth !== 1 || proof === undefined) continue
    const atRoot = normPath(r.path) === top
    if (r.state === 'removed') {
      if (r.prunable !== true) continue
      const skip = atRoot ? ROOT : gitFailed
      steps.push({ kind: 'worktrees', id: r.id, label: r.path, action: 'remove-record', ...(skip ? { skip } : {}) })
      continue
    }
    const skip = atRoot
      ? ROOT
      : (gitFailed ??
        (r.locked !== undefined ? lockText(r.locked) : undefined) ??
        agentWorks(auto.agents, proof) ??
        (enabled ? undefined : NOT_ENABLED))
    steps.push({ kind: 'worktrees', id: r.id, label: r.path, action: 'remove-worktree', ...(skip ? { skip } : {}) })
  }
  return steps
}

/** One git call in the root of the session. `timeoutMs` defaults to `gitTimeoutMs`. */
type Git = (argv: readonly string[], timeoutMs?: number) => Promise<RunResult>

/** `git worktree list --porcelain`, or the sentence for why it could not be read. */
async function listOf(git: Git): Promise<{ list: GitWorktree[] } | { error: string }> {
  try {
    const r = await git(['worktree', 'list', '--porcelain'])
    if (r.exitCode !== 0) return { error: `git failed: ${firstLine(r.stderr) || `exit ${r.exitCode}`}` }
    return { list: parsePorcelain(r.stdout) }
  } catch (e) {
    return { error: `git could not run: ${message(e)}` }
  }
}

/** Git's advice to force, in any wording: `--force`, or `-f` on its own (`remove -f -f`). */
const FORCE_ADVICE = /(^|\W)(--force|-f)(\W|$)/

/**
 * Git's refusal of a remove, in the words of the mod. The lock and the status are checked before, and a record is removed
 * only when git lists it as prunable, so a refusal here is a race. Git advises `--force` for a dirty tree and
 * `remove -f -f` for a lock: the outcome and the log must not repeat it, for a record or for a live tree.
 * The two known refusals are mapped by their English words (`ENGLISH` guarantees them). Any other refusal shows its first
 * line, unless that line still advises force: then it is `NO_FORCE`.
 */
function refusal(stderr: string): string {
  const line = firstLine(stderr)
  const reason = /lock reason: (.+)$/.exec(line)?.[1]
  if (/cannot remove a locked working tree/.test(line)) return lockText(reason?.trim() ?? '')
  if (/modified or untracked files|is dirty/.test(line)) return 'uncommitted or untracked files'
  return FORCE_ADVICE.test(line) ? NO_FORCE : line
}

/**
 * The outcome of one `git worktree remove <path>`: `done`, or why git refused (in the words of `refusal`) or could not run.
 * `timeoutMs` is the one of the remove of a live tree; the removal of a record keeps `gitTimeoutMs`.
 */
async function removeOf(git: Git, path: string, timeoutMs?: number): Promise<string> {
  try {
    const r = await git(['worktree', 'remove', path], timeoutMs)
    return r.exitCode === 0 ? 'done' : `skipped: ${refusal(r.stderr) || `git exit ${r.exitCode}`}`
  } catch (e) {
    return `skipped: git could not run: ${message(e)}`
  }
}

/**
 * The base refs that exist: `refs/heads/<branch of the main tree>` from the porcelain list, and the target of
 * `origin/HEAD` when a remote has set it (`git symbolic-ref -q` exits 1 with no such ref) and that target still resolves
 * to a commit: `symbolic-ref` names it even when the remote renamed its default branch and a prune deleted the old ref, and
 * `rev-list` would fail on the dead name. No fetch runs: a branch merged on a remote counts only once a fetch brought the
 * merge into a base ref.
 */
async function basesOf(git: Git, list: readonly GitWorktree[]): Promise<string[]> {
  const bases: string[] = []
  const main = list[0]
  if (main?.branch !== undefined && !main.bare) bases.push(`refs/heads/${main.branch}`)
  try {
    const r = await git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
    const ref = r.exitCode === 0 ? r.stdout.trim() : ''
    if (ref !== '' && !bases.includes(ref)) {
      const alive = await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`])
      if (alive.exitCode === 0) bases.push(ref)
    }
  } catch {
    // No answer is no ref: fewer bases means more trees count as unmerged, the safe side.
  }
  return bases
}

/** Whether the working tree at `path` has any change: modified, staged or untracked. The reason when it has, or cannot be read. */
async function dirtyOf(git: Git, path: string): Promise<string | undefined> {
  try {
    const r = await git(['-C', path, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])
    if (r.exitCode !== 0) return `git failed: ${firstLine(r.stderr) || `exit ${r.exitCode}`}`
    return r.stdout.trim() === '' ? undefined : 'uncommitted or untracked files'
  } catch (e) {
    return `git could not run: ${message(e)}`
  }
}

/**
 * The reason when the tree of `rec` holds another registered worktree, `undefined` when it holds none, or why the list cannot
 * be read. `git worktree remove` deletes the ignored files of a tree, and worktrees often live in an ignored folder (this
 * repo's `.claude/worktrees/`), so removing the outer tree would delete the inner one, also while an agent works in it, and
 * leave a stale record. Any other record counts: a locked one, one whose folder is gone, the main tree. The list is read now,
 * at the step of this tree, not taken from the one of the apply: a remove can run 120 s, and an agent can add a worktree
 * meanwhile. The path of the record is compared like the cwd of the session: as git lists it and as the proof has it (a
 * symlink alias). The reason names the record as git lists it.
 */
async function holdsOf(git: Git, proof: WorktreeProof, rec: GitWorktree): Promise<string | undefined> {
  const now = await listOf(git)
  if ('error' in now) return now.error
  const self = normPath(rec.path)
  const inner = now.list.find(w => normPath(w.path) !== self && (holds(rec.path, w.path) || holds(proof.path, w.path)))
  return inner === undefined ? undefined : `holds the worktree ${inner.path}`
}

/** The sha of `HEAD` in the tree at `path` just now, or why it cannot be read. */
async function headOf(git: Git, path: string): Promise<{ sha: string } | { error: string }> {
  try {
    const r = await git(['-C', path, 'rev-parse', '--verify', 'HEAD'])
    const sha = r.stdout.trim()
    return r.exitCode === 0 && sha !== '' ? { sha } : { error: 'no HEAD' }
  } catch (e) {
    return { error: `git could not run: ${message(e)}` }
  }
}

/** The reason when a commit of `head` is on no base ref, or when git could not count them. `undefined`: every commit is merged. */
async function unmergedOf(git: Git, head: string, bases: readonly string[]): Promise<string | undefined> {
  try {
    const r = await git(['rev-list', '--count', head, '--not', ...bases])
    if (r.exitCode !== 0) return `git failed: ${firstLine(r.stderr) || `exit ${r.exitCode}`}`
    const text = r.stdout.trim()
    const n = /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (Number.isNaN(n)) return 'git failed: unexpected answer'
    return n === 0 ? undefined : `${n} ${n === 1 ? 'commit' : 'commits'} not on ${bases.join(' or ')}`
  } catch (e) {
    return `git could not run: ${message(e)}`
  }
}

/** The part of the state that the agent guard reads: the agents of the run and the proofs that their places refer to. */
type Ledger = Pick<AutoState, 'agents' | 'worktrees'>

/**
 * What the guards of a live tree read. The base refs are read once for the whole apply. The cwd of the session and the agent
 * ledger are read at the check of each tree, like the `HEAD` sha: a remove can take 120 s, and both move while it runs.
 */
type Guards = {
  git: Git
  /** The list of `git worktree list --porcelain` of this apply, for the places of the agents. */
  list: readonly GitWorktree[]
  cwd(): Promise<{ cwd: string } | { error: string }>
  ledger(): Promise<Ledger | { error: string }>
  bases(): Promise<string[]>
}

/**
 * Why the live tree of `rec` must not be removed now, or `undefined` when every guard holds. The first that fails is the
 * answer, and git never hears of a remove. The order is the one of the study (#123, section 5.4), with one check added: the
 * cwd of the session, a running agent, another registered worktree inside the tree, a change in the working tree, then the
 * merge state of `HEAD`. The lock and the record were checked before. The cwd is compared with the path that git lists and
 * with the path of the proof, which can be a symlink alias of it.
 *
 * A running agent is one that the proof names (`agentWorks`: by path, by run and index, by owner), or one that the pane draws
 * in this record (`agentWorksIn`: by its spawn cwd, its branch, or the place of its parent, with the same rules as the Agents
 * section). The ledger is read here, at the step of this tree, not once for the apply: an agent that started in this tree
 * while an earlier remove ran counts.
 *
 * A tree that holds another registered worktree (`holdsOf`) is never removed, with an agent in the inner one or not: the
 * remove would delete it. The agent guard does not see that agent, because the pane draws it in the inner record.
 *
 * The merge state uses the sha that git reports for the tree now, read after the status. The `HEAD` of the list is as old as
 * every remove before this step (each can take 120 s), and a commit made in a detached tree since then leaves it clean: the
 * old sha would count as merged and the remove would leave the new commit on no ref. A commit that lands between the status
 * and this read counts as unmerged. Git has no atomic check-and-remove, so a gap of milliseconds remains.
 */
async function unsafeOf(g: Guards, proof: WorktreeProof, rec: GitWorktree): Promise<string | undefined> {
  const where = await g.cwd()
  if ('error' in where) return where.error
  if (holds(rec.path, where.cwd) || holds(proof.path, where.cwd)) return 'the session works in it'
  const ledger = await g.ledger()
  if ('error' in ledger) return ledger.error
  const works =
    agentWorks(ledger.agents, proof) ?? (agentWorksIn(ledger, g.list, where.cwd, rec) ? AGENT_WORKS : undefined)
  if (works !== undefined) return works
  const inner = await holdsOf(g.git, proof, rec)
  if (inner !== undefined) return inner
  const dirty = await dirtyOf(g.git, rec.path)
  if (dirty !== undefined) return dirty
  // A record with no `HEAD` line is the cheap first test. The sha, not the branch: a detached tree has none, and a remove
  // would leave its commits on no ref.
  if (rec.head === undefined || rec.head === '') return 'no HEAD'
  const head = await headOf(g.git, rec.path)
  if ('error' in head) return head.error
  const bases = await g.bases()
  if (bases.length === 0) return 'no base branch'
  return unmergedOf(g.git, head.sha, bases)
}

/**
 * The state as the next round would write it once these rows are gone: a row stays in the snapshot as `removed`, with no
 * `prunable` mark and no lock. A live row turns `removed` too (a tree that `--yes` removed, or that git no longer lists).
 * Until that round the plan would list them again, and each `--yes` would try them and log a no-op entry.
 *
 * The proof of each such row gets `removedAt: at`, as the round would stamp it: a live proof has none, and the Worktrees
 * section treats a removed row with no `removedAt` as over before any `--hide`, so it would vanish at once and come back
 * with the next round. A proof that has one keeps it, so the round that follows writes nothing more (A22).
 */
function removedRows(auto: AutoState, ids: ReadonlySet<string>, at: number): AutoState {
  const proofs = auto.worktrees.map(p =>
    ids.has(worktreeId(p.path)) && p.removedAt === undefined ? { ...p, removedAt: at } : p,
  )
  const snap = auto.snapshot
  if (!snap) return { ...auto, worktrees: proofs }
  const worktrees = snap.worktrees.map((r): WorktreeRow => {
    if (!ids.has(r.id) || (r.state === 'removed' && r.prunable === undefined && r.locked === undefined)) return r
    const next: WorktreeRow = { ...r, state: 'removed' }
    delete next.prunable
    delete next.locked
    return next
  })
  return { ...auto, worktrees: proofs, snapshot: { ...snap, worktrees } }
}

/** The outcome of a `remove-record` step whose record git lists: only a prunable record (its folder is gone) is removed. */
async function recordOutcome(git: Git, rec: GitWorktree): Promise<string> {
  if (rec.prunable === undefined) return 'skipped: the worktree is live'
  return removeOf(git, rec.path)
}

/**
 * The outcome of a `remove-worktree` step whose record git lists and does not lock: a gone folder, the first guard that
 * fails, or the one removal of the tree, with its own timeout and the words of the mod for a refusal.
 */
async function liveOutcome(g: Guards, proof: WorktreeProof, rec: GitWorktree): Promise<string> {
  if (rec.prunable !== undefined) return 'skipped: the directory is gone'
  const why = await unsafeOf(g, proof, rec)
  if (why !== undefined) return `skipped: ${why}`
  return removeOf(g.git, rec.path, REMOVE_TIMEOUT_MS)
}

/** What a step finds before its action: its outcome already (`gone`: the row has no record left), or its proof and record. */
type Found = { outcome: string; gone?: true } | { proof: WorktreeProof; rec: GitWorktree; list: readonly GitWorktree[] }

export const autoCleanup: Cleanup<AutoConfig, AutoState> = {
  plan,

  async apply(ctx, steps) {
    const auto = await ctx.data.get()
    const top = auto?.root?.top
    const config = ctx.config.slice()
    const git: Git = (argv, timeoutMs = config.gitTimeoutMs) =>
      ctx.tools.run('git', ['git', ...argv], {
        ...(typeof top === 'string' ? { cwd: top } : {}),
        timeoutMs,
        env: ENGLISH,
      })
    // One list for the whole apply, read when the first step needs it, so a run with nothing to remove runs no git.
    let listed: Awaited<ReturnType<typeof listOf>> | undefined
    let matched: ReturnType<typeof matchProofs> | undefined
    // The base refs: read when the first live tree needs them, once. The `HEAD` sha of a tree, the cwd of the session and the
    // agent ledger are not: each is read at the check of its tree (M1).
    let bases: Promise<string[]> | undefined
    const cwdOf = (): ReturnType<Guards['cwd']> =>
      ctx.session.cwd().then(
        value => ({ cwd: value }),
        () => ({ error: 'cannot read the session cwd' }),
      )
    const ledgerOf = async (): ReturnType<Guards['ledger']> => {
      try {
        const now = await ctx.data.get()
        return now === undefined ? { error: NO_LEDGER } : now
      } catch {
        return { error: NO_LEDGER }
      }
    }
    /** The checks that both actions share: the proof, the root, the switch, and the record that git lists. */
    const lookup = async (step: CleanStep): Promise<Found> => {
      const proof = auto?.worktrees.find(p => worktreeId(p.path) === step.id)
      if (proof === undefined) return { outcome: 'skipped: no proof that this run made it' }
      if (typeof top !== 'string') return { outcome: 'skipped: no git root' }
      if (normPath(proof.path) === normPath(top)) return { outcome: `skipped: ${ROOT}` }
      // The switch is read again here: a step that no plan gave must not remove a tree while it is off.
      if (step.action === 'remove-worktree' && !config.destroyWorktrees) return { outcome: `skipped: ${NOT_ENABLED}` }
      listed ??= await listOf(git)
      if ('error' in listed) return { outcome: `skipped: ${listed.error}` }
      const list = listed.list
      // The same lookup as the round (`trackWorktrees`): by path, then by branch when the recorded path is a symlink alias
      // and git lists the canonical one. Else the recheck would miss the record that the round marked prunable.
      matched ??= matchProofs(auto?.worktrees ?? [], list, top)
      const rec = matched.get(proof.path)
      // The lookup never takes the main tree or the record of the session root. A proof that names one by path is skipped.
      const held = rec === undefined ? findByPath(list, proof.path) : undefined
      if (held !== undefined && held === list[0]) return { outcome: 'skipped: the main worktree' }
      if (held !== undefined && held === locate(list, top)) return { outcome: `skipped: ${ROOT}` }
      if (rec === undefined) return { outcome: NO_RECORD, gone: true }
      return { proof, rec, list }
    }
    const out: CleanResult[] = []
    /** The rows whose record is gone now: removed by this run, or already gone when git was asked. */
    const gone = new Set<string>()
    for (const step of steps) {
      const found = await lookup(step)
      let outcome: string
      if ('outcome' in found) {
        outcome = found.outcome
        if (found.gone) gone.add(step.id)
      } else {
        const { proof, rec, list } = found
        // Git never prints `prunable` for a locked record (a locked worktree is not pruned), so the lock is checked first.
        if (rec.locked !== undefined) outcome = `skipped: ${lockText(rec.locked)}`
        else if (step.action === 'remove-worktree') {
          const guards: Guards = {
            git,
            list,
            cwd: cwdOf,
            ledger: ledgerOf,
            bases: () => (bases ??= basesOf(git, list)),
          }
          outcome = await liveOutcome(guards, proof, rec)
        } else outcome = await recordOutcome(git, rec)
        if (outcome === 'done') gone.add(step.id)
      }
      out.push({ id: step.id, outcome })
    }
    if (auto !== undefined && gone.size > 0) {
      const at = ctx.clock.wall()
      try {
        await ctx.data.update(cur => removedRows(cur ?? auto, gone, at))
      } catch (e) {
        // The records are gone either way: the next round writes the same rows.
        ctx.log(`auto: snapshot of the removed worktrees not updated: ${message(e)}`)
      }
    }
    return out
  },
}

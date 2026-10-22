// `/track clean` for worktrees (issue #122): the cleanup of the auto tracker. The plan lists each removed child worktree that
// this run has a proof for and whose record git still lists as prunable. `--yes worktrees` removes the git record of each,
// one path at a time, as
// `git worktree remove <path>` by argument vector. It is never `git worktree prune`: prune takes no path and clears every
// prunable record of the repo, the ones the mod does not own too (design study of #49, S3).
// `git worktree remove` also deletes the directory of a worktree that is still there, so a step runs only when git itself,
// asked just now, lists the record as prunable: its directory is gone. A live, locked or main record is never removed, and
// there is no `--force`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design study: issue #49, R14 and G12.

import type { CleanResult, CleanStep, Cleanup } from '../../core/interfaces/clean'
import { findByPath, type GitWorktree, locate, normPath, parsePorcelain } from '../../core/lib/porcelain'
import { firstLine, message } from '../../core/lib/text'
import type { AutoConfig } from './config'
import { worktreeId } from './ids'
import type { AutoState } from './types'
import { matchProofs } from './worktrees'

const ROOT = 'the root of the session'

/**
 * The removed child rows that this run has a proof for and whose record git still lists as prunable. A removed row with no
 * record has nothing left to remove, so it is no step: a step would be tried, and so logged, on each `--yes`. The root of the
 * session is listed with its reason, and is never applied.
 */
function plan(ctx: { data: AutoState | undefined }): CleanStep[] {
  const auto = ctx.data
  const snap = auto?.snapshot
  if (!auto || !snap) return []
  const proved = new Set(auto.worktrees.map(p => worktreeId(p.path)))
  const top = typeof auto.root?.top === 'string' ? normPath(auto.root.top) : undefined
  const gitFailed = snap.git.ok ? undefined : `git failed: ${snap.git.error ?? 'unknown error'}`
  return snap.worktrees
    .filter(r => r.depth === 1 && r.state === 'removed' && r.prunable === true && proved.has(r.id))
    .map((r): CleanStep => {
      const skip = normPath(r.path) === top ? ROOT : gitFailed
      return { kind: 'worktrees', id: r.id, label: r.path, action: 'remove-record', ...(skip ? { skip } : {}) }
    })
}

type Git = (argv: readonly string[]) => Promise<{ exitCode: number; stderr: string; stdout: string }>

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

/** The outcome of the one removal: `done`, or why git refused or could not run. */
async function removeOf(git: Git, path: string): Promise<string> {
  try {
    const r = await git(['worktree', 'remove', path])
    return r.exitCode === 0 ? 'done' : `skipped: ${firstLine(r.stderr) || `git exit ${r.exitCode}`}`
  } catch (e) {
    return `skipped: git could not run: ${message(e)}`
  }
}

/**
 * The state as the next round would write it once these records are gone: the rows stay `removed`, with no `prunable` mark.
 * Until that round the plan would list them again, and each `--yes` would try them and log a no-op entry.
 */
function unmarked(auto: AutoState, ids: ReadonlySet<string>): AutoState {
  const snap = auto.snapshot
  if (!snap) return auto
  const worktrees = snap.worktrees.map(r => {
    if (!ids.has(r.id) || r.prunable === undefined) return r
    const next = { ...r }
    delete next.prunable
    return next
  })
  return { ...auto, snapshot: { ...snap, worktrees } }
}

export const autoCleanup: Cleanup<AutoConfig, AutoState> = {
  plan,

  async apply(ctx, steps) {
    const auto = await ctx.data.get()
    const top = auto?.root?.top
    const git: Git = argv =>
      ctx.tools.run('git', ['git', ...argv], {
        ...(typeof top === 'string' ? { cwd: top } : {}),
        timeoutMs: ctx.config.slice().gitTimeoutMs,
      })
    // One list for the whole apply, read when the first step needs it, so a run with nothing to remove runs no git.
    let listed: Awaited<ReturnType<typeof listOf>> | undefined
    let matched: ReturnType<typeof matchProofs> | undefined
    const out: CleanResult[] = []
    /** The rows whose record is gone now: removed by this run, or already gone when git was asked. */
    const gone = new Set<string>()
    for (const step of steps) {
      const done = (outcome: string): void => void out.push({ id: step.id, outcome })
      const proof = auto?.worktrees.find(p => worktreeId(p.path) === step.id)
      if (proof === undefined) {
        done('skipped: no proof that this run made it')
        continue
      }
      if (typeof top !== 'string') {
        done('skipped: no git root')
        continue
      }
      if (normPath(proof.path) === normPath(top)) {
        done(`skipped: ${ROOT}`)
        continue
      }
      listed ??= await listOf(git)
      if ('error' in listed) {
        done(`skipped: ${listed.error}`)
        continue
      }
      const list = listed.list
      // The same lookup as the round (`trackWorktrees`): by path, then by branch when the recorded path is a symlink alias
      // and git lists the canonical one. Else the recheck would miss the record that the round marked prunable.
      matched ??= matchProofs(auto?.worktrees ?? [], list, top)
      const rec = matched.get(proof.path)
      // The lookup never takes the main tree or the record of the session root. A proof that names one by path is skipped.
      const held = rec === undefined ? findByPath(list, proof.path) : undefined
      if (held !== undefined && held === list[0]) done('skipped: the main worktree')
      else if (held !== undefined && held === locate(list, top)) done(`skipped: ${ROOT}`)
      else if (rec === undefined) {
        gone.add(step.id)
        done('skipped: git has no record of it')
      }
      // Git never prints `prunable` for a locked record (a locked worktree is not pruned), so the lock is checked first.
      else if (rec.locked !== undefined) done(rec.locked === '' ? 'skipped: locked' : `skipped: locked: ${rec.locked}`)
      else if (rec.prunable === undefined) done('skipped: the worktree is live')
      else {
        const outcome = await removeOf(git, rec.path)
        if (outcome === 'done') gone.add(step.id)
        done(outcome)
      }
    }
    if (auto !== undefined && gone.size > 0) {
      try {
        await ctx.data.update(cur => unmarked(cur ?? auto, gone))
      } catch (e) {
        // The records are gone either way: the next round writes the same rows.
        ctx.log(`auto: snapshot of the removed worktrees not updated: ${message(e)}`)
      }
    }
    return out
  },
}

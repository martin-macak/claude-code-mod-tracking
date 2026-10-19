// AutoRound (spec 8): worktrees, then agents, then one save of the snapshot. Each step catches its own failure.
// A refused `auto` write is not recorded anywhere: the round goes on, and the next round writes again.
// No `$`: it gets plain closures. A round reads `auto` for inputs only and writes through `save(change)`,
// where `change` re-runs the pure units on the current value (A20).
// The pull requests are not here since plan L5, Task 12: the github tracker finds them after the round, from the fact
// `auto.branches` that the tracker publishes (spec 5.9, the PR lane). Auto never calls `gh`.

import { parsePorcelain } from '../../core/lib/porcelain'
import type { Now, RunResult } from '../../hooks/contracts'
import { trackAgents } from './agents'
import type { AutoConfig } from './config'
import { setRootTop } from './ledger'
import type { AutoSnapshot, AutoState, GitWorktree, Health, LiveAgent } from './types'
import { trackWorktrees } from './worktrees'

/** The numbers a round reads, once per step: the auto slice. A round that gets none uses today's numbers. */
export type RoundCaps = Pick<AutoConfig, 'maxBranches' | 'maxProofs' | 'workflowIdleMs'>

export type RoundDeps = {
  now: Now
  /** Read for inputs only. The round never writes this copy back (A20). */
  load: () => Promise<AutoState>
  /** register: setAuto. `change` gets the current value and may run more than once. */
  save: (change: (cur: AutoState) => AutoState) => Promise<AutoState>
  git: (argv: readonly string[], cwd: string) => Promise<RunResult> // rejects like Runner
  listAgents: () => Promise<LiveAgent[]>
  sessionCwd: () => Promise<string>
  /** Read at each step, so a changed config file shows at the next round. Absent: today's numbers. */
  caps?: () => RoundCaps
}

const firstLine = (s: string): string => s.trim().split('\n')[0]?.trim() ?? ''
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type GitOut = { ok: true; res: RunResult } | { ok: false; error: string }

/** A snapshot without its times, so a quiet round compares equal (A22). */
function sig(x: AutoSnapshot): string {
  return JSON.stringify([
    x.worktrees,
    x.agents,
    x.branches,
    x.overflow,
    [x.git.ok, x.git.error ?? null],
    [x.agentList.ok, x.agentList.error ?? null],
  ])
}

export class AutoRound {
  /** The last porcelain list that git answered. Used when git fails. */
  private lastList: GitWorktree[] = []

  constructor(private readonly d: RoundDeps) {}

  /**
   * One round. Never rejects. Settles after the snapshot save. True when the round reached the save, so the branches it
   * left are worth publishing; false when there was no run yet (no pinned root) or the round threw.
   */
  async run(): Promise<boolean> {
    try {
      return await this.step()
    } catch {
      return false // the scheduler's next tick runs again
    }
  }

  private async git(argv: readonly string[], cwd: string): Promise<GitOut> {
    try {
      return { ok: true, res: await this.d.git(argv, cwd) }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
  }

  /** A refused write gives null. The caller keeps its own copy and goes on. */
  private async save(change: (cur: AutoState) => AutoState): Promise<AutoState | null> {
    try {
      return await this.d.save(change)
    } catch {
      return null
    }
  }

  private async step(): Promise<boolean> {
    const at = this.d.now()
    let s = await this.d.load()
    if (!s.root) return false // no run yet

    // Step 1: worktrees (spec 8.1).
    let top = s.root.top
    let revError: string | undefined
    if (top === undefined) {
      const r = await this.git(['rev-parse', '--show-toplevel'], s.root.cwd)
      if (r.ok && r.res.exitCode === 0 && r.res.stdout.trim() !== '') top = r.res.stdout.trim()
      else if (r.ok && /not a git repository/i.test(r.res.stderr)) top = null
      else revError = r.ok ? firstLine(r.res.stderr) || `exit ${r.res.exitCode}` : r.error
      if (top !== undefined) {
        const resolved = top
        s = (await this.save(cur => setRootTop(cur, resolved))) ?? s
      }
    }
    let git: Health = { ok: true, at }
    let list: GitWorktree[] = []
    if (typeof top === 'string') {
      const r = await this.git(['worktree', 'list', '--porcelain'], top)
      if (r.ok && r.res.exitCode === 0) {
        list = parsePorcelain(r.res.stdout)
        this.lastList = list
      } else {
        list = this.lastList
        git = { ok: false, at, error: r.ok ? firstLine(r.res.stderr) || `exit ${r.res.exitCode}` : r.error }
      }
    } else if (top === undefined) {
      list = this.lastList
      git = { ok: false, at, error: revError ?? 'git rev-parse failed' }
    }

    // Step 2: agents (spec 8.2), then one save of the snapshot.
    let live: LiveAgent[] | null = null
    let agentList: Health = { ok: true, at }
    try {
      live = await this.d.listAgents()
    } catch (err) {
      agentList = { ok: false, at, error: message(err) }
    }
    let masterCwd: string | null = null
    try {
      masterCwd = await this.d.sessionCwd()
    } catch {
      masterCwd = null
    }
    const caps = this.d.caps?.()
    await this.save(cur => this.snapshotOf(cur, list, live, masterCwd, at, git, agentList, caps))
    return true
  }

  /** Runs `trackWorktrees` and `trackAgents` again on the current value, then builds the snapshot (A20, A22). */
  private snapshotOf(
    cur: AutoState,
    list: readonly GitWorktree[],
    live: readonly LiveAgent[] | null,
    masterCwd: string | null,
    at: number,
    git: Health,
    agentList: Health,
    caps: RoundCaps | undefined,
  ): AutoState {
    const wv = trackWorktrees(cur, list, at, caps)
    const av = trackAgents(wv.state, live, list, masterCwd, at, caps?.workflowIdleMs)
    const prev = cur.snapshot
    const next: AutoSnapshot = {
      at,
      worktrees: wv.rows,
      agents: av.rows,
      branches: wv.branches,
      overflow: wv.overflow,
      git,
      agentList,
    }
    if (av.state === cur && prev && sig(prev) === sig(next)) return cur
    return { ...av.state, snapshot: next }
  }
}

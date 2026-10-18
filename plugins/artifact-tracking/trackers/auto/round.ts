// AutoRound (spec 8): worktrees, agents, then pull requests in their own lane. Each step catches its own failure.
// A refused `auto` write is not recorded anywhere: the round goes on, and the next round writes again.
// No `$`: it gets plain closures. A round reads `auto` for inputs only and writes through `save(change)`,
// where `change` re-runs the pure units on the current value (A20).

import { parsePorcelain } from '../../core/lib/porcelain'
import type {
  AutoReason,
  AutoSnapshot,
  AutoState,
  DiscoveryApplied,
  GitHubDiscoveryApi,
  GitWorktree,
  Health,
  ItemRecord,
  LiveAgent,
  Now,
  Ref,
  RepoRef,
  RunResult,
} from '../../hooks/contracts'
import { prKey } from '../../hooks/model/keys'
import { applyDiscovery } from '../github/discovered'
import { prBodyRefs } from '../github/pr-body'
import { discoverPrs } from '../github/pr-discovery'
import { trackAgents } from './agents'
import { setRootTop } from './ledger'
import { trackWorktrees } from './worktrees'

/**
 * The github values of the PR lane: the `first:` counts of the discovery query, the closing refs read per PR and the refs
 * read from one PR body. The github slice has them; the item runtime serves them through `AutoGithub.lane()`.
 */
export type AutoLane = {
  headPrsPerBranch: number
  basePrsPerBranch: number
  closingRefsPerPr: number
  maxBodyRefs: number
}

export type RoundDeps = {
  now: Now
  /** Read for inputs only. The round never writes this copy back (A20). */
  load: () => Promise<AutoState>
  /** register: setAuto. `change` gets the current value and may run more than once. */
  save: (change: (cur: AutoState) => AutoState) => Promise<AutoState>
  git: (argv: readonly string[], cwd: string) => Promise<RunResult> // rejects like Runner
  listAgents: () => Promise<LiveAgent[]>
  sessionCwd: () => Promise<string>
  /** Session repo after ensureRepo. null: none. */
  repo: () => Promise<RepoRef | null>
  gh: GitHubDiscoveryApi
  /** Waits for the cached `gh --version` probe. */
  ghReady: () => Promise<boolean>
  githubHosts: () => readonly string[]
  /**
   * Change the item list. `change` gets the current list and the current dismiss list, read inside
   * the change (register: from `autoMirror`), and may run more than once. Returns the committed result.
   * Register reads first and skips `update` when the change returns the input list itself (A22).
   */
  applyItems: (
    change: (list: ItemRecord[], dismissed: ReadonlySet<string>) => DiscoveryApplied,
  ) => Promise<DiscoveryApplied>
  /** New keys to refresh: register passes coordinator.kick('capture', keys). */
  onAdded: (keys: string[]) => void
}

/** The reasons that start a PR step. Another reason starts one only when the tracked branches changed. */
const PR_REASONS: ReadonlySet<AutoReason> = new Set(['start', 'tick', 'manual', 'pr-event'])

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
    prsSig(x.prs),
    x.defaultBranch ?? null,
  ])
}
const prsSig = (p: AutoSnapshot['prs']) => [p.ok, p.skipped ?? null, p.error ?? null, p.untracked ?? 0]

function withPrs(cur: AutoState, prs: AutoSnapshot['prs'], defaultBranch?: string): AutoState {
  const snap = cur.snapshot
  if (!snap) return cur
  const db = defaultBranch ?? snap.defaultBranch
  if (JSON.stringify(prsSig(snap.prs)) === JSON.stringify(prsSig(prs)) && db === snap.defaultBranch) return cur
  return { ...cur, snapshot: { ...snap, prs, ...(db !== undefined ? { defaultBranch: db } : {}) } }
}

export class AutoRound {
  /** The last porcelain list that git answered. Used when git fails. */
  private lastList: GitWorktree[] = []
  private prRunning = false
  private prQueued = false
  private prWaiters: Array<() => void> = []

  constructor(private readonly d: RoundDeps) {}

  /**
   * One round. Never rejects. Settles after the snapshot save; the PR step starts in its lane and is not awaited (A16).
   */
  async run(reasons: ReadonlySet<AutoReason>): Promise<void> {
    try {
      await this.step(reasons)
    } catch {
      // The scheduler's next tick runs again.
    }
  }

  /** Settles when no PR step is in flight or queued. */
  idle(): Promise<void> {
    if (!this.prRunning) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.prWaiters.push(resolve)
    })
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

  private async step(reasons: ReadonlySet<AutoReason>): Promise<void> {
    const at = this.d.now()
    let s = await this.d.load()
    if (!s.root) return // no run yet

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
    const committed = (await this.save(cur => this.snapshotOf(cur, list, live, masterCwd, at, git, agentList))) ?? s

    // Step 3: pull requests, in their own lane (spec 8.3, A16).
    const branches = committed.snapshot?.branches ?? []
    const before = s.snapshot?.branches ?? []
    const changed = branches.length !== before.length || branches.some((b, i) => b !== before[i])
    if ([...reasons].some(r => PR_REASONS.has(r)) || changed) this.requestPr()
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
  ): AutoState {
    const wv = trackWorktrees(cur, list, at)
    const av = trackAgents(wv.state, live, list, masterCwd, at)
    const prev = cur.snapshot
    const next: AutoSnapshot = {
      at,
      worktrees: wv.rows,
      agents: av.rows,
      branches: wv.branches,
      overflow: wv.overflow,
      git,
      agentList,
      prs: prev?.prs ?? { ok: true },
      ...(prev?.defaultBranch !== undefined ? { defaultBranch: prev.defaultBranch } : {}),
    }
    if (av.state === cur && prev && sig(prev) === sig(next)) return cur
    return { ...av.state, snapshot: next }
  }

  // ---------------------------------------------------------------- the PR lane

  private requestPr(): void {
    if (this.prRunning) {
      this.prQueued = true
      return
    }
    void this.runLane()
  }

  /** One PR step at a time. A request during a step queues as one and runs after it. */
  private async runLane(): Promise<void> {
    this.prRunning = true
    try {
      do {
        this.prQueued = false
        try {
          await this.prStep()
        } catch {
          // The next tick asks again.
        }
      } while (this.prQueued)
    } finally {
      this.prRunning = false
      const done = this.prWaiters
      this.prWaiters = []
      for (const w of done) w()
    }
  }

  /** One PR step. A throw in any part of it lands in the Pull requests note, as an `ok: false` outcome does. */
  private async prStep(): Promise<void> {
    try {
      await this.discover()
    } catch (err) {
      const at = this.d.now()
      const error = message(err)
      await this.d.save(cur => withPrs(cur, { at, ok: false, error }))
    }
  }

  private async discover(): Promise<void> {
    const start = await this.d.load()
    const branches = start.snapshot?.branches ?? []
    const defaultBranch = start.snapshot?.defaultBranch
    await this.d.ghReady()
    const repo = await this.d.repo()
    const at = this.d.now()
    const out = await discoverPrs(this.d.gh, repo, branches, at, defaultBranch)
    if (!out.ok) {
      await this.d.save(cur =>
        withPrs(cur, {
          at,
          ok: false,
          ...(out.skipped ? { skipped: out.skipped } : {}),
          ...(out.error ? { error: out.error } : {}),
        }),
      )
      return
    }
    const refsByPr = new Map<string, Ref[]>()
    for (const pr of out.prs) refsByPr.set(prKey(pr), prBodyRefs(pr, this.d.githubHosts()))
    const r = await this.d.applyItems((list, dismissed) =>
      applyDiscovery(list, { prs: out.prs, refsByPr, complete: out.complete, dismissed, at }),
    )
    this.d.onAdded(r.added)
    await this.d.save(cur =>
      withPrs(cur, { at, ok: true, ...(r.untracked > 0 ? { untracked: r.untracked } : {}) }, out.defaultBranch),
    )
  }
}

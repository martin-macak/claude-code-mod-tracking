// The PR lane (spec 8.3, A16): after each round of the auto tracker, one GraphQL query finds the PRs of the tracked
// branches, and the lane writes them, and the refs in their bodies, into the item list with the reason `discovered`. It moved here
// from the auto round in plan L5, Task 12 (spec 5.9, the PR lane): auto publishes the fact `auto.branches`, core tells
// this tracker when it changes, and the lane starts a step. Auto never calls `gh`.
// The PRs the session created (the fact `auto.prs`, issue #158) are asked for by number in any repo, and also get the
// reason `created`.
// One step at a time. A request during a step queues as one more and runs after it. Every step catches its own failure.
// No `$`: it gets plain closures (`LaneDeps`).

import type { Claim, StoredItem } from '../../core/interfaces/items'
import type { Now, RepoRef, Timer } from '../../core/interfaces/ports'
import { type GitWorktree, worktreeOfBranch } from '../../core/lib/porcelain'
import type { PrLane as LaneCaps } from './config'
import { applyDiscovery } from './discovered'
import { forgetNotes, mergeNotes, retryDelay, type Seen } from './merge'
import { type BodyScan, prBodyRefs } from './pr-body'
import { discoverPrs } from './pr-discovery'
import type {
  BranchesFact,
  DiscoveredPr,
  DiscoveryApplied,
  DiscoveryTool,
  ForeignRepo,
  LaneState,
  MergeNote,
  PrRef,
} from './types'
import { prKey } from './urls'

/** The state of a lane that has not run: a good outcome, which draws nothing. */
export const EMPTY_LANE: LaneState = { prs: { ok: true } }

/** The reasons that start a PR step. Another reason starts one only when the tracked branches changed. */
export const PR_REASONS: ReadonlySet<string> = new Set(['start', 'tick', 'manual', 'pr-event'])

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Whether a new `auto.branches` starts a step: it is a new round, and either its reasons name one that opens the lane
 * (`start`, `tick`, `manual`, `pr-event`) or the tracked branches changed since the last value. A fact published at
 * init has no reasons and no previous value, so it starts nothing.
 */
export function wantsStep(next: BranchesFact, prev: BranchesFact | undefined): boolean {
  if (next.seq === prev?.seq) return false
  if (next.reasons.some(r => PR_REASONS.has(r))) return true
  return prev !== undefined && !sameList(next.branches, prev.branches)
}

export interface LaneDeps {
  now: Now
  /** The state of the lane: read for inputs only. A lane that never ran reads as `EMPTY_LANE`. */
  load(): Promise<LaneState>
  /** `change` gets the current value and may run more than once. A change that returns its input writes nothing (A22). */
  save(change: (cur: LaneState) => LaneState): Promise<LaneState>
  /** The last `auto.branches`. */
  branches(): BranchesFact | undefined
  /**
   * The PRs the session created, from the fact `auto.prs` (issue #158). The lane asks for them by number, in any repo.
   * Absent: none.
   */
  created?(): readonly PrRef[]
  /**
   * The repos other than the session repo and the branches the session proved in them, from the fact `repos.branches`
   * (issue #195). The lane asks each one for those branches, in one query per repo. Absent: none.
   */
  foreign?(): readonly ForeignRepo[]
  gh: DiscoveryTool
  /** Waits for the cached `gh --version` probe. */
  ghReady(): Promise<boolean>
  /** The session repo, after it was looked up. null: none. */
  repo(): Promise<RepoRef | null>
  /** The claims in the text of a PR body. */
  scanBody: BodyScan
  /** The record a claim makes (`ItemStorePort.build`). */
  build(claim: Claim): StoredItem | null
  /**
   * Changes the item list. `change` gets the current list and the current dismiss list, and may run more than once.
   * Returns the committed result. The writer reads first and writes nothing when the change returns the input list.
   */
  applyItems(
    change: (list: StoredItem[], dismissed: ReadonlySet<string>) => DiscoveryApplied,
  ): Promise<DiscoveryApplied>
  /** New keys to refresh. */
  onAdded(keys: readonly string[]): void
  /** The github values of the lane, read at each step: a changed config file shows at the next one. */
  lane(): LaneCaps
  /**
   * `global.refresh.staleMs` (a discovered record stays current for half of it), and the cap of the store: the lane writes the
   * whole list, so it caps it as the store does (`global.store.maxItems`, `file.maxFiles` and the rank of a record).
   */
  caps(): { staleMs: number; cap: (list: StoredItem[]) => StoredItem[] }
  /**
   * The worktrees of the session repo (`git worktree list --porcelain`). null: git could not say. Called at most once a
   * step, and only when an open PR is CONFLICTING. Absent: no worktree is found, so no PR can be resolved.
   */
  worktrees?(): Promise<readonly GitWorktree[] | null>
  /** An engine timer that the host cancels at dispose. Absent: a PR that GitHub calls UNKNOWN waits for the next tick. */
  after?(ms: number, fn: () => void): Timer
}

type Prs = LaneState['prs']

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A note without its time, so a quiet step compares equal (A22). */
const prsSig = (p: Prs): string =>
  JSON.stringify([p.ok, p.skipped ?? null, p.error ?? null, p.host ?? null, p.untracked ?? 0])

/**
 * What a good step adds to the lane state. `merge` holds the new merge notes, `merge: undefined` meaning none are left; no
 * `merge` key (a failed step) keeps what the last good step found. `foreignDefaults` adds the default branches that foreign
 * repos named: equal values change nothing (A22).
 */
type LanePatch = {
  defaultBranch?: string
  merge?: LaneState['merge']
  foreignDefaults?: Record<string, string>
}

/** The lane state after a step: the note, and the patch of a good step (the default branch the reply named, the notes). */
function withPrs(cur: LaneState, prs: Prs, patch: LanePatch = {}): LaneState {
  const db = patch.defaultBranch ?? cur.defaultBranch
  const merge = 'merge' in patch ? patch.merge : cur.merge
  const learned = patch.foreignDefaults
  const fresh = learned !== undefined && Object.entries(learned).some(([k, v]) => cur.foreignDefaults?.[k] !== v)
  if (prsSig(cur.prs) === prsSig(prs) && db === cur.defaultBranch && merge === cur.merge && !fresh) return cur
  const foreignDefaults = fresh ? { ...cur.foreignDefaults, ...learned } : cur.foreignDefaults
  return {
    prs,
    ...(db !== undefined ? { defaultBranch: db } : {}),
    ...(merge !== undefined ? { merge } : {}),
    ...(foreignDefaults !== undefined ? { foreignDefaults } : {}),
  }
}

export class PrLane {
  private running = false
  private queued = false
  private waiters: Array<() => void> = []
  /** The extra step that waits for a PR GitHub still calls UNKNOWN. One at a time. */
  private retry: Timer | undefined

  constructor(private readonly d: LaneDeps) {}

  /** Asks for a step. It starts now, or runs after the one in flight. Never rejects, and does not wait. */
  request(): void {
    if (this.running) {
      this.queued = true
      return
    }
    void this.run()
  }

  /** Settles when no step is in flight or queued. */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  /** One step at a time. A request during a step queues as one and runs after it. */
  private async run(): Promise<void> {
    this.running = true
    try {
      do {
        this.queued = false
        try {
          await this.step()
        } catch {
          // The next round asks again.
        }
      } while (this.queued)
    } finally {
      this.running = false
      const done = this.waiters
      this.waiters = []
      for (const w of done) w()
    }
  }

  /** One PR step. A throw in any part of it lands in the Pull requests note, as an `ok: false` outcome does. */
  private async step(): Promise<void> {
    try {
      await this.discover()
    } catch (err) {
      const at = this.d.now()
      const error = message(err)
      await this.d.save(cur => withPrs(cur, { at, ok: false, error }))
    }
  }

  private async discover(): Promise<void> {
    const { d } = this
    const loaded = await d.load()
    const branches = d.branches()?.branches ?? []
    await d.ghReady()
    const repo = await d.repo()
    const at = d.now()
    const lane = d.lane()
    const out = await discoverPrs(d.gh, repo, branches, at, loaded.defaultBranch, lane, {
      created: d.created?.() ?? [],
      foreign: d.foreign?.() ?? [],
      foreignDefaults: loaded.foreignDefaults,
    })
    if (!out.ok) {
      // A step that finds nothing to ask is no failure, but it must not keep the PRs of other repos whose proof is gone.
      const gone = out.skipped === 'no-branches' || out.skipped === 'no-repo' ? await this.dropUnproven(at) : []
      const saved = await d.save(cur =>
        withPrs(
          cur,
          {
            at,
            ok: false,
            ...(out.skipped ? { skipped: out.skipped } : {}),
            ...(out.error ? { error: out.error } : {}),
            ...(out.host ? { host: out.host } : {}),
          },
          gone.length > 0 ? { merge: forgetNotes(cur.merge, new Set(gone)) } : {},
        ),
      )
      if (gone.length > 0) this.rearm(saved.merge)
      return
    }
    const refsByPr = new Map<string, readonly Claim[]>()
    for (const pr of out.prs) refsByPr.set(prKey(pr), prBodyRefs(pr, d.scanBody, lane.maxBodyRefs))
    const { staleMs, cap } = d.caps()
    let hidden: ReadonlySet<string> = new Set()
    // The lane PRs of a foreign repo with no sure answer keep their marker, as a created PR that got none does, except a PR
    // that the reply returned: it was read, so its marker follows the reply. A reply that is not complete for the session
    // repo holds its lane PRs, and each other repo is still reconciled by its own answer (issue #195).
    const r = await d.applyItems((list, dismissed) => {
      hidden = dismissed
      return applyDiscovery(list, {
        prs: out.prs,
        refsByPr,
        complete: out.complete,
        held: new Set(out.held),
        heldRepos: new Set(out.heldRepos),
        dismissed,
        at,
        build: claim => d.build(claim),
        caps: { staleMs, maxAutoItems: lane.maxAutoItems, cap },
      })
    })
    d.onAdded(r.added)
    const seen = await this.seen(out.prs, hidden)
    // `r.held` has no PR that the person dismissed: it is no PR of the lane and keeps no note (a retry would run on it).
    const kept = new Set(r.held)
    const saved = await d.save(cur =>
      withPrs(
        cur,
        { at, ok: true, ...(r.untracked > 0 ? { untracked: r.untracked } : {}) },
        {
          ...(out.defaultBranch !== undefined ? { defaultBranch: out.defaultBranch } : {}),
          // The notes of the PRs that lost the marker go, an incomplete reply or not: the lane lists them no more.
          merge: forgetNotes(mergeNotes(cur.merge, seen, { keepMissing: !out.complete, keep: kept }), new Set(r.gone)),
          ...(out.foreignDefaults !== undefined ? { foreignDefaults: out.foreignDefaults } : {}),
        },
      ),
    )
    this.rearm(saved.merge)
  }

  /**
   * A step that asks nothing (`no-branches`: no tracked branch, no created PR and no proven branch of another repo; or
   * `no-repo`: no GitHub repo for the branches) says nothing of the PRs that earlier steps found in other repos. Their last
   * proof may have gone since (issue #195): the last Repos row was dismissed, `trackers.repos.pollRepos` is 0, or the only
   * visited worktree is detached. It is the rule of every reply that is not complete for the session repo, with a reply that
   * names no PR (`applyDiscovery`): each lane PR of another repo loses its `lane` marker, and the refs of its body lose
   * their `via` entry. The lane PRs of the session repo are held, as a PR that got no answer is: the step asked nothing of
   * the session repo, so it says nothing of its PRs, as before. A list with no PR of another repo does not change (A22), so
   * a first step with no branch at all only skips. Returns the keys that lost the marker.
   */
  private async dropUnproven(at: number): Promise<string[]> {
    const { d } = this
    const { staleMs, cap } = d.caps()
    const { maxAutoItems } = d.lane()
    const r = await d.applyItems((list, dismissed) =>
      applyDiscovery(list, {
        prs: [],
        refsByPr: new Map(),
        complete: false,
        dismissed,
        at,
        build: claim => d.build(claim),
        caps: { staleMs, maxAutoItems, cap },
      }),
    )
    return r.gone
  }

  /**
   * What this step saw of each open PR that the person did not dismiss. The worktrees are looked up once, and only when
   * some PR of this repo is CONFLICTING: no PR to resolve, no git call. A lookup that fails leaves the PRs with no worktree.
   */
  private async seen(prs: readonly DiscoveredPr[], dismissed: ReadonlySet<string>): Promise<Seen[]> {
    const open = prs.filter(p => p.state === 'open' && !dismissed.has(prKey(p)))
    // A fork PR gets no lookup: its head name is a branch of the fork, and a local branch of that name is another one. A
    // PR of another repo gets none either: its head name is a branch of that repo, not of the session repo (issue #158).
    const wantsTree = (p: DiscoveredPr): boolean => p.mergeable === 'CONFLICTING' && !p.crossRepo && !p.otherRepo
    const trees = open.some(wantsTree) ? await this.worktreeList() : []
    return open.map(p => {
      const path = wantsTree(p) ? worktreeOfBranch(trees, p.headRefName)?.path : undefined
      return { key: prKey(p), mergeable: p.mergeable, ...(path !== undefined ? { worktree: path } : {}) }
    })
  }

  private async worktreeList(): Promise<readonly GitWorktree[]> {
    try {
      return (await this.d.worktrees?.()) ?? []
    } catch {
      return []
    }
  }

  /**
   * One extra step for the PRs that GitHub still calls UNKNOWN: after 3 s, 6 s, then 12 s, then the tick alone. It
   * replaces a timer that still waits, so the PR that was asked least decides. No UNKNOWN PR left: no timer.
   */
  private rearm(merge: Record<string, MergeNote> | undefined): void {
    this.retry?.cancel()
    this.retry = undefined
    const wait = retryDelay(merge)
    if (wait === undefined || this.d.after === undefined) return
    this.retry = this.d.after(wait, () => {
      this.retry = undefined
      this.request()
    })
  }
}

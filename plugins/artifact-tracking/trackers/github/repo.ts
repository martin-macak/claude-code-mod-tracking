// The session repo, found for the github kind: the git remote first, else one `gh repo view`. A github.com remote is
// final at once (no CLI call, so a replay can wait for it); a host that is not github.com counts only when `gh` is
// logged in there. The answer is published as the facts `session.repo` (a repo, or
// absent for none) and `github.hosts` (the extra hosts whose URLs are GitHub's), and a bare `#N` in the list moves to
// its real key. One lookup per session: the memo is keyed by the facts of the load, and a switch forgets it first.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 8, K21.

import type { Json, PrepareContext } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { FactsPort } from '../../core/interfaces/tracker'
import { resolveBareRefs } from './bare'
import { ghOf } from './client'

/**
 * What the lookup uses of a context. A kind's `prepare` gets all of it from the item host, and the PR lane gets it from
 * the context of the github tracker, so both share one lookup per session.
 */
export type RepoContext = Pick<PrepareContext, 'facts' | 'items' | 'session' | 'tools' | 'config' | 'clock'>

/** The bare `#N` key of an item whose repo was not known when it was seen. */
const BARE = 'gh:?#'

/** What the git remote says: the repo it names (null: none), and whether that answer is final or `gh` must be asked. */
type Remote = { repo: RepoRef | null; final: boolean }

/**
 * One lookup of a session. `local` settles when the git remote is read; a final answer (a github.com remote, or a fault)
 * is published by then. `done` settles when the answer is final whatever the path (`gh` may be asked).
 */
type Lookup = { local: Promise<Remote>; done: Promise<void> }

/** The lookup of each load's facts, memoised while the session stays the same. */
const lookups = new WeakMap<FactsPort, Lookup>()

function publish(ctx: RepoContext, repo: RepoRef | null, hosts: string[]): void {
  ctx.facts.publish('session.repo', (repo ?? undefined) as unknown as Json | undefined)
  ctx.facts.publish('github.hosts', hosts)
  if (repo) ctx.items.refresh() // the items that waited for a repo (a GHE host needs its auth check) are due
}

/**
 * The remote did not name github.com: ask `gh`. A remote host that gh does not know is an ssh alias
 * (git@github-work:o/r) or not GitHub at all. Drop it and ask `gh repo view`, which resolves aliases.
 */
async function viaGh(ctx: RepoContext, remote: RepoRef | null): Promise<void> {
  let repo = remote
  let hosts: string[] = []
  try {
    const gh = ghOf(ctx.tools, ctx.config, () => ctx.clock.wall())
    if (gh) {
      if (repo && repo.host !== 'github.com') {
        await gh.probe()
        if (gh.isAvailable && (await gh.checkHost(repo.host))) hosts = [repo.host]
        else repo = null
      }
      if (!repo) {
        await gh.probe()
        if (gh.isAvailable) {
          repo = await gh.defaultRepo()
          if (repo && repo.host !== 'github.com') {
            if (await gh.checkHost(repo.host)) hosts = [repo.host]
            else repo = null
          }
        }
      }
    }
  } catch {
    repo = null // No repo: a bare #N stays unresolved.
    hosts = []
  }
  publish(ctx, repo, hosts)
}

/** The git remote first, with no CLI call. A github.com remote is the answer; a fault is the answer: no repo. */
function begin(ctx: RepoContext): Lookup {
  const local = Promise.resolve()
    .then(() => ctx.session.repo())
    .then(
      (repo): Remote => ({ repo, final: repo?.host === 'github.com' }),
      (): Remote => ({ repo: null, final: true }),
    )
    .then(remote => {
      if (remote.final) publish(ctx, remote.repo, [])
      return remote
    })
  return { local, done: local.then(remote => (remote.final ? undefined : viaGh(ctx, remote.repo))) }
}

/** A bare `#N` of a stored copy or a transcript moves to its real key once the repo is known. A list with none is left alone. */
async function rekey(ctx: RepoContext): Promise<void> {
  const repo = ctx.facts.read<Json>('session.repo') as unknown as RepoRef | undefined
  if (!repo) return
  try {
    const moved = await ctx.items.update(list =>
      list.some(r => r.key.startsWith(BARE)) ? resolveBareRefs(list, repo) : list,
    )
    if (moved) ctx.items.refresh()
  } catch {
    // A refused write must not poison the memo. Every later capture awaits it.
  }
}

/** The lookup of this session: the one that runs, or a new one. */
function lookupOf(ctx: RepoContext): Lookup {
  let lookup = lookups.get(ctx.facts)
  if (!lookup) {
    lookup = begin(ctx)
    lookups.set(ctx.facts, lookup)
  }
  return lookup
}

/**
 * The session repo for a caller that only reads it (the PR lane): waits for the lookup of this session, starting it
 * when none runs, and answers the fact. It re-keys nothing and writes no item; the kind's `prepare` does that. Never rejects.
 */
export async function foundRepo(ctx: RepoContext): Promise<RepoRef | null> {
  await lookupOf(ctx).done.catch(() => {})
  return (ctx.facts.read<Json>('session.repo') as unknown as RepoRef | undefined) ?? null
}

/**
 * Finds the session repo once per session, then re-keys the bare `#N` the list holds (cheap: it reads the list and
 * writes only when one is there). Never rejects. `quick` (a replay): returns once the git remote is read. The `gh`
 * lookup, when the remote is not github.com, runs on; a later full call waits for it and re-keys.
 */
export async function ensureRepo(ctx: PrepareContext, o: { quick?: boolean } = {}): Promise<void> {
  const lookup = lookupOf(ctx)
  if (o.quick) {
    lookup.done.catch(() => {}) // it runs on; nobody waits for it here
    await lookup.local
    return
  }
  await lookup.done
  await rekey(ctx)
}

/** The switch begins: the new session has its own repo. Forget the old one before a load or the replay looks it up. */
export function forgetRepo(ctx: PrepareContext): void {
  lookups.delete(ctx.facts)
  ctx.facts.publish('session.repo', undefined)
  ctx.facts.publish('github.hosts', undefined)
}

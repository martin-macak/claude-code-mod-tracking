// Discovered items (spec A9 to A12, 8.4): PRs on tracked branches and the refs in their bodies.
// Pure: no `$`. A call that changes nothing returns its input list (A22).

import type { Claim, JsonObject, StoredItem } from '../../core/interfaces/items'
import { GLOBAL_DEFAULTS } from '../../core/lib/global-config'
import { addReason, dropReason } from '../../core/lib/reasons'
import { type BaseRecord, enforceCap, isAutoOnly, isDiscovered } from '../../core/lib/records'
import { PR_LANE_DEFAULTS } from './config'
import { githubKind } from './kind'
import { isLanePr } from './lane-pr'
import type { DiscoveredPr, DiscoveryApplied, GitHubRecord } from './types'
import { githubKey, prKey } from './urls'

/** The issue keys of the PR's closing references, in reply order. */
const closesOf = (pr: DiscoveredPr): string[] => pr.closing.map(c => githubKey(c.host, c.owner, c.repo, c.number))

/** The fields discovery writes on a PR record (spec 8.4 step 1). `closes` only when the PR closes an issue. */
function discoveryFields(pr: DiscoveredPr) {
  const closes = closesOf(pr)
  return {
    type: 'pr' as const,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    checks: pr.checks,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    ...(pr.crossRepo ? { crossRepo: true as const } : {}),
    ...(pr.reviewDecision !== undefined ? { reviewDecision: pr.reviewDecision } : {}),
    ...(pr.mergeable !== undefined ? { mergeable: pr.mergeable } : {}),
    ...(pr.mergeStateStatus !== undefined ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(closes.length > 0 ? { closes } : {}),
  }
}

function isCurrent(rec: GitHubRecord, pr: DiscoveredPr, at: number, staleMs: number): boolean {
  return (
    isLanePr(rec) &&
    rec.error === undefined &&
    rec.type === 'pr' &&
    rec.url === pr.url &&
    rec.title === pr.title &&
    rec.state === pr.state &&
    rec.isDraft === pr.isDraft &&
    rec.checks === pr.checks &&
    rec.headRefName === pr.headRefName &&
    rec.baseRefName === pr.baseRefName &&
    rec.crossRepo === pr.crossRepo &&
    rec.reviewDecision === pr.reviewDecision &&
    rec.mergeable === pr.mergeable &&
    rec.mergeStateStatus === pr.mergeStateStatus &&
    (rec.closes ?? []).join(' ') === closesOf(pr).join(' ') &&
    at - (rec.refreshedAt ?? Number.NEGATIVE_INFINITY) < staleMs / 2
  )
}

function withDiscovery(rec: GitHubRecord, pr: DiscoveredPr, at: number): GitHubRecord {
  const next: GitHubRecord = {
    ...rec,
    lane: true,
    reasons: addReason(rec.reasons, 'discovered'),
    ...discoveryFields(pr),
    refreshedAt: at,
  }
  delete next.error
  if (pr.crossRepo === undefined) delete next.crossRepo
  if (pr.reviewDecision === undefined) delete next.reviewDecision
  if (pr.mergeable === undefined) delete next.mergeable
  if (pr.mergeStateStatus === undefined) delete next.mergeStateStatus
  if (pr.closing.length === 0) delete next.closes
  return next
}

/**
 * The claim of a PR the lane found: seen now, from `auto`. The github kind makes the record of it. `source` is the label
 * of the claim, as `prompt` is for a text. No record keeps it: `sources` holds channels only, so `newPrRecord` clears it.
 */
function prClaim(pr: DiscoveredPr, at: number): Claim {
  const fields = { host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number, type: 'pr', url: pr.url }
  return { category: 'github', key: prKey(pr), source: 'auto', reason: 'discovered', at, fields: fields as JsonObject }
}

function newPrRecord(pr: DiscoveredPr, at: number): GitHubRecord {
  const base = githubKind.merge(null, prClaim(pr, at)) as GitHubRecord
  return { ...base, sources: [], lane: true, seenCount: 0, ...discoveryFields(pr), refreshedAt: at }
}

/** The numbers `applyDiscovery` reads: how long a record stays current, and the two item caps. */
export type DiscoveryCaps = { staleMs: number; maxAutoItems: number; maxItems: number }

/**
 * The label of the claim of a ref that a PR body named. `build` gets each claim with it and the time of the step, whatever
 * the scan said. No record keeps it: `sources` holds channels only, so the new record has none.
 */
const BODY_SOURCE = 'pr-body'

export function applyDiscovery(
  list: readonly StoredItem[],
  input: {
    prs: readonly DiscoveredPr[]
    /** The claims in the body of each PR, by the key of the PR (`prBodyRefs`). */
    refsByPr: ReadonlyMap<string, readonly Claim[]>
    complete: boolean
    dismissed: ReadonlySet<string>
    at: number
    /** The record a claim of any kind makes (`ItemStorePort.build`). null: the claim adds no record. */
    build: (claim: Claim) => StoredItem | null
    /** The PR lane passes its own. A direct caller gets today's numbers. */
    caps?: DiscoveryCaps
  },
): DiscoveryApplied {
  const { refsByPr, complete, dismissed, at, build } = input
  const caps = input.caps ?? {
    staleMs: GLOBAL_DEFAULTS.refresh.staleMs,
    maxAutoItems: PR_LANE_DEFAULTS.maxAutoItems,
    maxItems: GLOBAL_DEFAULTS.store.maxItems,
  }
  const out: StoredItem[] = list.slice()
  const index = new Map<string, number>(out.map((r, i) => [r.key, i]))
  const added: string[] = []
  const notAdded = new Set<string>()
  let changed = false
  // 0. The budget for new auto-only items. Existing records always update.
  let budget = caps.maxAutoItems - list.filter(isAutoOnly).length

  const livePrs = input.prs.filter(pr => !dismissed.has(prKey(pr)))
  const live = new Set(livePrs.map(prKey))

  // 1. PRs, in reply order (head aliases first).
  for (const pr of livePrs) {
    const key = prKey(pr)
    const i = index.get(key)
    if (i !== undefined) {
      const rec = out[i]!
      if (rec.category !== 'github' || isCurrent(rec as GitHubRecord, pr, at, caps.staleMs)) continue
      out[i] = withDiscovery(rec as GitHubRecord, pr, at)
      changed = true
    } else if (budget > 0) {
      budget--
      index.set(key, out.length)
      out.push(newPrRecord(pr, at))
      changed = true
    } else {
      notAdded.add(key)
    }
  }

  // 2. Body refs.
  for (const pr of livePrs) {
    const pk = prKey(pr)
    for (const claim of refsByPr.get(pk) ?? []) {
      const rk = claim.key
      if (dismissed.has(rk)) continue
      const i = index.get(rk)
      if (i !== undefined) {
        const rec = out[i]!
        const via = viaOf(rec)
        const hasVia = via.includes(pk)
        if (isDiscovered(rec) && hasVia) continue
        const next = {
          ...rec,
          reasons: addReason(rec.reasons, 'discovered'),
          via: hasVia ? via : [...via, pk],
        } as BaseRecord & Pick<GitHubRecord, 'lane'>
        // A marker with no `discovered` outlived a load: a body ref must not make the record a lane PR again.
        if (next.lane === true && !isDiscovered(rec)) delete next.lane
        out[i] = next
        changed = true
      } else if (budget > 0) {
        const rec = build({ ...claim, source: BODY_SOURCE, reason: 'discovered', at }) as BaseRecord | null
        if (!rec) continue // no kind makes a record of it
        budget--
        rec.sources = []
        rec.seenCount = 0
        rec.via = [pk]
        index.set(rk, out.length)
        out.push(rec)
        added.push(rk)
        changed = true
      } else {
        notAdded.add(rk)
      }
    }
  }

  // 3. Prune (A12), only after a complete reply.
  const drop = new Set<number>()
  if (complete) {
    // A `via` entry stays only while its PR is live and the body of that PR still lists the ref.
    const listed = new Map(livePrs.map(pr => [prKey(pr), new Set((refsByPr.get(prKey(pr)) ?? []).map(c => c.key))]))
    for (let i = 0; i < out.length; i++) {
      const rec = out[i]!
      const held = rec.via as string[] | undefined
      let via = held
      // The lane marker stays only while the lane still finds the PR.
      const laneHeld = rec.lane === true
      const lane = laneHeld && live.has(rec.key)
      if (via) {
        const kept = via.filter(k => listed.get(k)?.has(rec.key) === true)
        if (kept.length !== via.length) via = kept.length > 0 ? kept : undefined
      }
      // The reason `discovered` stays while the lane finds the record or a body of a live PR still names it.
      const found = lane || (via !== undefined && via.length > 0)
      const reasons = isDiscovered(rec) && !found ? dropReason(rec.reasons, 'discovered') : rec.reasons
      if (lane === laneHeld && via === held && reasons === rec.reasons) continue
      changed = true
      if (reasons === undefined) {
        drop.add(i)
        continue
      }
      const next = { ...rec, reasons } as BaseRecord & Pick<GitHubRecord, 'lane'>
      if (via === undefined) delete next.via
      else next.via = via
      if (!lane) delete next.lane
      out[i] = next
    }
  }

  // 4. Cap on the non-auto items only.
  const kept = drop.size > 0 ? out.filter((_, i) => !drop.has(i)) : out
  const capped = enforceCap(kept, caps.maxItems)
  if (capped !== kept) changed = true

  // 5. Quiet step: the input list itself.
  return { list: changed ? capped : (list as StoredItem[]), added, untracked: notAdded.size }
}

/** The keys of the PRs that name this record in their body. */
const viaOf = (rec: StoredItem): string[] => (Array.isArray(rec.via) ? (rec.via as string[]) : [])

// `dropAuto` moved to the record algebra in plan L5, Task 4. The store imports it from here until Task 8.
export { dropAuto } from '../../core/lib/records'

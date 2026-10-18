// Discovered items (spec A9 to A12, 8.4): PRs on tracked branches and the refs in their bodies.
// Pure: no `$`. A call that changes nothing returns its input list (A22).

import type { DiscoveredPr, DiscoveryApplied, GitHubRecord, ItemRecord, Ref, Source } from '../../hooks/contracts'
import { AUTO_SOURCES, LIMITS } from '../../hooks/contracts'
import { isAutoOnly, keyOf, prKey } from '../../hooks/model/keys'
import { enforceCap, recordFromRef } from '../../hooks/model/registry'

const isAuto = (s: Source): boolean => AUTO_SOURCES.has(s)

/** The issue keys of the PR's closing references, in reply order. */
const closesOf = (pr: DiscoveredPr): string[] =>
  pr.closing.map(c =>
    keyOf({ category: 'github', host: c.host, owner: c.owner, repo: c.repo, number: c.number, type: 'issue' }),
  )

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
    ...(pr.reviewDecision !== undefined ? { reviewDecision: pr.reviewDecision } : {}),
    ...(closes.length > 0 ? { closes } : {}),
  }
}

function isCurrent(rec: GitHubRecord, pr: DiscoveredPr, at: number): boolean {
  return (
    rec.sources.includes('auto') &&
    rec.error === undefined &&
    rec.type === 'pr' &&
    rec.url === pr.url &&
    rec.title === pr.title &&
    rec.state === pr.state &&
    rec.isDraft === pr.isDraft &&
    rec.checks === pr.checks &&
    rec.headRefName === pr.headRefName &&
    rec.baseRefName === pr.baseRefName &&
    rec.reviewDecision === pr.reviewDecision &&
    (rec.closes ?? []).join(' ') === closesOf(pr).join(' ') &&
    at - (rec.refreshedAt ?? Number.NEGATIVE_INFINITY) < LIMITS.staleMs / 2
  )
}

function withDiscovery(rec: GitHubRecord, pr: DiscoveredPr, at: number): GitHubRecord {
  const next: GitHubRecord = {
    ...rec,
    sources: rec.sources.includes('auto') ? rec.sources : [...rec.sources, 'auto'],
    ...discoveryFields(pr),
    refreshedAt: at,
  }
  delete next.error
  if (pr.reviewDecision === undefined) delete next.reviewDecision
  if (pr.closing.length === 0) delete next.closes
  return next
}

function newPrRecord(pr: DiscoveredPr, at: number): GitHubRecord {
  const base = recordFromRef(
    { category: 'github', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number, type: 'pr', url: pr.url },
    { source: 'auto', at },
  ) as GitHubRecord
  return { ...base, seenCount: 0, ...discoveryFields(pr), refreshedAt: at }
}

export function applyDiscovery(
  list: readonly ItemRecord[],
  input: {
    prs: readonly DiscoveredPr[]
    refsByPr: ReadonlyMap<string, readonly Ref[]>
    complete: boolean
    dismissed: ReadonlySet<string>
    at: number
  },
): DiscoveryApplied {
  const { refsByPr, complete, dismissed, at } = input
  const out: ItemRecord[] = list.slice()
  const index = new Map<string, number>(out.map((r, i) => [r.key, i]))
  const added: string[] = []
  const notAdded = new Set<string>()
  let changed = false
  // 0. The budget for new auto-only items. Existing records always update.
  let budget = LIMITS.maxAutoItems - list.filter(isAutoOnly).length

  const livePrs = input.prs.filter(pr => !dismissed.has(prKey(pr)))
  const live = new Set(livePrs.map(prKey))

  // 1. PRs, in reply order (head aliases first).
  for (const pr of livePrs) {
    const key = prKey(pr)
    const i = index.get(key)
    if (i !== undefined) {
      const rec = out[i]!
      if (rec.category !== 'github' || isCurrent(rec, pr, at)) continue
      out[i] = withDiscovery(rec, pr, at)
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
    for (const ref of refsByPr.get(pk) ?? []) {
      const rk = keyOf(ref)
      if (dismissed.has(rk)) continue
      const i = index.get(rk)
      if (i !== undefined) {
        const rec = out[i]!
        const hasSource = rec.sources.includes('pr-body')
        const hasVia = rec.via?.includes(pk) === true
        if (hasSource && hasVia) continue
        out[i] = {
          ...rec,
          sources: hasSource ? rec.sources : [...rec.sources, 'pr-body'],
          via: hasVia ? (rec.via as string[]) : [...(rec.via ?? []), pk],
        }
        changed = true
      } else if (budget > 0) {
        budget--
        const rec = recordFromRef(ref, { source: 'pr-body', at })
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
    const listed = new Map(livePrs.map(pr => [prKey(pr), new Set((refsByPr.get(prKey(pr)) ?? []).map(keyOf))]))
    for (let i = 0; i < out.length; i++) {
      const rec = out[i]!
      let sources = rec.sources
      let via = rec.via
      if (sources.includes('auto') && !live.has(rec.key)) sources = sources.filter(s => s !== 'auto')
      if (via) {
        const kept = via.filter(k => listed.get(k)?.has(rec.key) === true)
        if (kept.length !== via.length) via = kept.length > 0 ? kept : undefined
      }
      if (sources.includes('pr-body') && (via === undefined || via.length === 0))
        sources = sources.filter(s => s !== 'pr-body')
      if (sources === rec.sources && via === rec.via) continue
      changed = true
      if (sources.length === 0) {
        drop.add(i)
        continue
      }
      const next: ItemRecord = { ...rec, sources }
      if (via === undefined) delete next.via
      else next.via = via
      out[i] = next
    }
  }

  // 4. Cap on the non-auto items only.
  const kept = drop.size > 0 ? out.filter((_, i) => !drop.has(i)) : out
  const capped = enforceCap(kept, LIMITS.maxItems)
  if (capped !== kept) changed = true

  // 5. Quiet step: the input list itself.
  return { list: changed ? capped : (list as ItemRecord[]), added, untracked: notAdded.size }
}

/** Removes `auto`, `pr-body` and `via` from the given keys. A record left with no source goes. */
export function dropAuto(list: readonly ItemRecord[], keys: ReadonlySet<string>): ItemRecord[] {
  let changed = false
  const out: ItemRecord[] = []
  for (const rec of list) {
    if (!keys.has(rec.key) || (!rec.sources.some(isAuto) && rec.via === undefined)) {
      out.push(rec)
      continue
    }
    changed = true
    const sources = rec.sources.filter(s => !isAuto(s))
    if (sources.length === 0) continue
    const next: ItemRecord = { ...rec, sources }
    delete next.via
    out.push(next)
  }
  return changed ? out : (list as ItemRecord[])
}

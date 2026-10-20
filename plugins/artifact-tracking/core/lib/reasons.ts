// The reason algebra (issue #62): the fixed precedence, the merge of two sightings of one item, the reason a source
// stands for, and the check of the reasons a kind adds. Pure: no input is mutated, and a call that changes nothing
// returns its input, so a caller can test for a change with `===`. The check of a kind's reasons never throws: it drops
// a bad reason and reports a problem, as the KeyRegistry does for a key.
//
// `ReasonSet.all` is kept in precedence order, strongest first. A set of seen reasons has one such order, so the merge
// of claims does not depend on the order they come in. `first` is the one field that does: it is the reason of the
// earliest sighting. A claim joins a record that is older than it, so `addReason` keeps `first`. Two whole records fold
// by `firstSeen` (`joinReasons`), so `first` does not depend on which of them is `a`.

import type { CoreReason, KindReason, ReasonSet, Traceable } from '../interfaces/reasons'

/** `deleted > created > updated > published > read > discovered > mentioned`. Strongest first. */
export const REASON_ORDER: readonly CoreReason[] = [
  'deleted',
  'created',
  'updated',
  'published',
  'read',
  'discovered',
  'mentioned',
]

const RANK: ReadonlyMap<string, number> = new Map(REASON_ORDER.map((r, i) => [r, i]))

export const isCoreReason = (v: unknown): v is CoreReason => typeof v === 'string' && RANK.has(v)

/** The reasons in precedence order, each once. */
const ordered = (reasons: Iterable<CoreReason>): CoreReason[] =>
  [...new Set(reasons)].sort((a, b) => RANK.get(a)! - RANK.get(b)!)

/** The set of one sighting: `reason` is first, all and strongest. */
export function reasonSet(reason: CoreReason): ReasonSet {
  return { first: reason, all: [reason], strongest: reason }
}

/** The set with one more reason. `first` stays. The same set comes back when the reason is already in it. */
export function addReason(set: ReasonSet, reason: CoreReason): ReasonSet {
  if (set.all.includes(reason)) return set
  const all = ordered([...set.all, reason])
  return { first: set.first, all, strongest: all[0]! }
}

/**
 * Two sets of one item, from two records. `first` comes from the record that was seen first: `a` when `firstFrom` is
 * `'a'`, else `b`. The caller says which, by `firstSeen`. `a` itself comes back when it already holds everything.
 */
export function joinReasons(a: ReasonSet, b: ReasonSet, firstFrom: 'a' | 'b'): ReasonSet {
  const first = firstFrom === 'a' ? a.first : b.first
  const all = ordered([...a.all, ...b.all])
  if (first === a.first && all.length === a.all.length) return a
  return { first, all, strongest: all[0]! }
}

/**
 * The set without `reason`. When `first` was that reason, it falls to the strongest that is left. undefined: nothing is
 * left, so the item has no reason to stay. The same set comes back when it does not hold the reason.
 */
export function dropReason(set: ReasonSet, reason: CoreReason): ReasonSet | undefined {
  if (!set.all.includes(reason)) return set
  const all = set.all.filter(r => r !== reason)
  if (all.length === 0) return undefined
  return { first: set.first === reason ? all[0]! : set.first, all, strongest: all[0]! }
}

/** True for a value that is a well-formed set: core words only, strongest first, `first` and `strongest` inside `all`. */
export function isReasonSet(v: unknown): v is ReasonSet {
  if (typeof v !== 'object' || v === null) return false
  const { first, all, strongest } = v as Record<string, unknown>
  if (!Array.isArray(all) || all.length === 0 || !all.every(isCoreReason)) return false
  if (!isCoreReason(first) || !isCoreReason(strongest) || !all.includes(first)) return false
  return strongest === all[0] && ordered(all).join() === all.join()
}

/**
 * The records that have a valid set of reasons. A record from a build before issue #62 has none, and a kind or a merge
 * reads `reasons.strongest` and `reasons.all` of every record, so such a record stays out of the list: the old store is
 * dropped, not migrated (#55 decides, and #62 repeats it). It holds for a stored copy and for a live list that a hot
 * reload kept. The same array comes back when no record goes, so a caller can test for a change with `===`.
 */
export function withReasons<T extends { readonly reasons?: unknown }>(list: T[]): T[] {
  const kept = list.filter(rec => isReasonSet(rec.reasons))
  return kept.length === list.length ? list : kept
}

/**
 * The reason a source stands for. A tool result is a `read`; the PR lane (the claim labels `auto` and `pr-body`)
 * `discovered` the item; text of the conversation, and any source that is not a channel (`scan`, `prepare`, `load`: they
 * build lookups, not records), is a `mention`. The labels of the lane stand for a reason only on a claim: no record keeps
 * them in `sources`, which holds channels only. Total: it never throws.
 */
export function reasonOfSource(source: string): CoreReason {
  if (source === 'tool') return 'read'
  if (source === 'auto' || source === 'pr-body') return 'discovered'
  return 'mentioned'
}

/** True for a tracker that can say why each row is tracked (`Traceable`): the slot trackers repos, processes and auto. */
export const isTraceable = <T extends object>(tracker: T): tracker is T & Traceable =>
  typeof (tracker as Partial<Traceable>).reasonsOf === 'function'

// ---------------------------------------------------------------- the reasons a kind adds

/** What a check of kind reasons leaves: the words that stay on, and one line for each word it dropped. */
export type KindReasonCheck<K = readonly KindReason[]> = { readonly kept: K; readonly problems: readonly string[] }

/**
 * Checks what one kind declares and keeps the words that pass. A word is dropped, with a problem, when it is empty, is
 * not mapped to a core reason, is a core word already, or repeats a word that came before it in the same kind. It never
 * throws: a bad word is off, and the kind and the mod go on, as for a key that is taken (KeyRegistry).
 */
export function keepKindReasons(category: string, declared: readonly KindReason[] | undefined): KindReasonCheck {
  const kept: KindReason[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  const off = (why: string): void => void problems.push(`reasons: kind ${category} ${why}. The reason is off.`)
  for (const r of declared ?? []) {
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (id === '') off('declares an empty reason')
    else if (!isCoreReason(r.core)) off(`reason "${id}" is not mapped to a core reason`)
    else if (isCoreReason(id)) off(`reason "${id}" is already a core reason`)
    else if (seen.has(id)) off(`declares reason "${id}" twice`)
    else {
      seen.add(id)
      kept.push(r)
    }
  }
  return { kept, problems }
}

/**
 * Checks the reasons of every kind: each kind passes `keepKindReasons`. A word two kinds share must map to the same
 * core reason in both, so a filter that reads the core word means one thing for it. The kind that comes later loses a
 * word that clashes. The kept words are by category; a kind with no word left has an empty list.
 */
export function checkKindReasons(
  kinds: readonly { readonly category: string; readonly reasons?: readonly KindReason[] | undefined }[],
): KindReasonCheck<ReadonlyMap<string, readonly KindReason[]>> {
  const owner = new Map<string, { category: string; core: CoreReason }>()
  const kept = new Map<string, readonly KindReason[]>()
  const problems: string[] = []
  for (const kind of kinds) {
    const own = keepKindReasons(kind.category, kind.reasons)
    problems.push(...own.problems)
    const stay: KindReason[] = []
    for (const r of own.kept) {
      const first = owner.get(r.id)
      if (first === undefined || first.core === r.core) {
        owner.set(r.id, first ?? { category: kind.category, core: r.core })
        stay.push(r)
      } else {
        problems.push(
          `reasons: kind ${kind.category} maps "${r.id}" to ${r.core}, but kind ${first.category} maps it to ${first.core}. The reason is off.`,
        )
      }
    }
    kept.set(kind.category, stay)
  }
  return { kept, problems }
}

/**
 * The core reason of a word the kind declared. Throws for a word it did not declare, and for one of its words that the
 * check drops (`keepKindReasons`: empty, unmapped, a core word, a repeat): a word that is off never passes as a guess.
 * A kind calls it with `KindContext.kindReasons`, when it makes a claim. Capture catches the throw for each kind, so the
 * kind gives no claim and the others still count. That list is what `checkKindReasons` kept, so a word that lost a
 * clash with an earlier kind is off there too: the kind's raw `reasons` list cannot see the other kinds, and a kind
 * must not pass it here.
 */
export function kindReason(declared: readonly KindReason[] | undefined, id: string): CoreReason {
  const found = keepKindReasons('', declared).kept.find(r => r.id === id)
  if (found === undefined)
    throw new Error(`reasons: "${id}" is not a reason the kind declared and mapped to a core reason`)
  return found.core
}

// The merge state of a PR (issue #50): the chip a row shows, the notes the PR lane keeps for the rows, and the retry
// schedule for a PR that GitHub still calls UNKNOWN. GitHub works out `mergeable` lazily: the first answer after a push
// to the head or the base can be UNKNOWN. Pure: no `$`, no clock. The caller passes the time.

import type { ToolStatus } from '../../core/interfaces/tracker'
import type { Tone } from '../../core/lib/rows'
import type { GitHubRecord, LaneState, Mergeable, MergeNote } from './types'

/** The wait before each new look at a PR that is still UNKNOWN: three retries, then the normal tick alone. */
export const RETRY_MS: readonly number[] = [3_000, 6_000, 12_000]

/** The UNKNOWN count at which the retries are spent: the first look and one per retry. */
export const UNKNOWN_SPENT = RETRY_MS.length + 1

/** How long a row reads `queued` after the person pressed resolve, unless the PR changes first. */
export const QUEUED_MS = 10 * 60_000

/** What the rows read of the lane: whether the values are current, the notes by PR key, and the time of the draw. */
export type MergeEnv = {
  /** False while `gh` is logged out, missing or its breaker is open: the stored value is stale, so it shows nowhere. */
  fresh: boolean
  notes: Readonly<Record<string, MergeNote>>
  now: number
}

export type Chip = { text: string; tone: Tone }

/** What the rows read of a view: `gh` from the tool statuses, the notes from the lane state, and the time. */
export const mergeEnvOf = (v: {
  tools: Readonly<Record<string, ToolStatus>>
  data: LaneState | undefined
  now: number
}): MergeEnv => ({ fresh: isFresh(v.tools.gh), notes: v.data?.merge ?? {}, now: v.now })

/** A value is stale while `gh` cannot be asked. A tool nobody asked yet is no sign of it: the stored value stands. */
export function isFresh(gh: ToolStatus | undefined): boolean {
  return gh === undefined || (gh.loggedIn !== false && gh.available !== false && gh.breaker !== 'open')
}

const openPr = (rec: GitHubRecord): boolean => rec.type === 'pr' && rec.state === 'open'

/** True while the person's press is recent. The note goes with the PR's change; the time is the backstop. */
export const isQueued = (note: MergeNote | undefined, now: number): boolean =>
  note?.queuedAt !== undefined && now - note.queuedAt < QUEUED_MS

/**
 * The merge chip of a PR row, or null. `CONFLICTING` outranks every other word and never reads `mergeStateStatus`: a
 * draft PR reads `DRAFT` there, which would hide a conflict. `UNKNOWN` shows nothing until the lane spent its retries.
 */
export function mergeChip(rec: GitHubRecord, env: MergeEnv | undefined): Chip | null {
  if (env === undefined || !env.fresh || !openPr(rec)) return null
  const note = env.notes[rec.key]
  switch (rec.mergeable) {
    case 'CONFLICTING':
      return isQueued(note, env.now) ? { text: 'queued', tone: 'warn' } : { text: '✗ conflicts', tone: 'bad' }
    case 'MERGEABLE':
      return rec.mergeStateStatus === 'BEHIND' ? { text: '↓ behind', tone: 'warn' } : null
    case 'UNKNOWN':
      return (note?.unknown ?? 0) >= UNKNOWN_SPENT ? { text: '? merge', tone: 'dim' } : null
    default:
      return null
  }
}

/**
 * True for a PR that is open and CONFLICTING while the values are current. No lane state, or a stale one (`gh` cannot be
 * asked), says nothing about a conflict. The chip, the band and the status token of the row all read this.
 */
export const isConflicted = (rec: GitHubRecord, env: MergeEnv | undefined): boolean =>
  env?.fresh === true && openPr(rec) && rec.mergeable === 'CONFLICTING'

/** The note of a PR whose conflict the row may describe: open, CONFLICTING, and the values current. */
export function conflictNote(rec: GitHubRecord, env: MergeEnv | undefined): MergeNote | undefined {
  return isConflicted(rec, env) ? env?.notes[rec.key] : undefined
}

/** How many of the PRs are open and CONFLICTING, for the band. None while the values are stale. */
export function conflictCount(recs: readonly GitHubRecord[], env: MergeEnv | undefined): number {
  return recs.filter(r => isConflicted(r, env)).length
}

/** The UNKNOWN count after one more step that asked about the PR, never past `UNKNOWN_SPENT`. */
const countLook = (note: MergeNote | undefined): number => Math.min(UNKNOWN_SPENT, (note?.unknown ?? 0) + 1)

/** What a step saw of one open PR. `worktree` is looked up for a CONFLICTING PR only. */
export type Seen = { key: string; mergeable: Mergeable | undefined; worktree?: string }

/**
 * The notes after a step: one per PR that is CONFLICTING (worktree, and what the person did, which stays while the PR
 * stays CONFLICTING) or UNKNOWN (the steps that asked about it, capped). A PR with any other value has none, so a
 * change starts afresh. Returns `prev` itself when nothing changed (A22), and undefined when no note is left.
 * `keepMissing` keeps the notes of the PRs that `seen` does not name: the reply that `seen` comes from was incomplete.
 * A kept CONFLICTING note stays as it is. A kept UNKNOWN note still counts the step, as a PR in the reply would: the
 * lane asked, and an answer that never comes must not call for a retry without end (AC4).
 */
export function mergeNotes(
  prev: Readonly<Record<string, MergeNote>> | undefined,
  seen: readonly Seen[],
  o: { keepMissing?: boolean } = {},
): Record<string, MergeNote> | undefined {
  const next: Record<string, MergeNote> = {}
  for (const s of seen) {
    const old = prev?.[s.key]
    if (s.mergeable === 'CONFLICTING') {
      next[s.key] = {
        ...(s.worktree !== undefined ? { worktree: s.worktree } : {}),
        ...(old?.queuedAt !== undefined ? { queuedAt: old.queuedAt } : {}),
        ...(old?.files !== undefined ? { files: old.files } : {}),
      }
    } else if (s.mergeable === 'UNKNOWN') {
      next[s.key] = { unknown: countLook(old) }
    }
  }
  if (o.keepMissing) {
    // A reply that was incomplete does not say a PR is gone: it may only have left it out.
    const named = new Set(seen.map(s => s.key))
    for (const [key, note] of Object.entries(prev ?? {}))
      if (!named.has(key)) next[key] = note.unknown === undefined ? note : { unknown: countLook(note) }
  }
  if (JSON.stringify(next) === JSON.stringify(prev ?? {})) return prev
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * The wait before the next extra step: the PR that was asked least decides. undefined when no PR is UNKNOWN with
 * retries left, and so no step is due.
 */
export function retryDelay(notes: Readonly<Record<string, MergeNote>> | undefined): number | undefined {
  const waiting = Object.values(notes ?? {}).flatMap(n =>
    n.unknown !== undefined && n.unknown > 0 && n.unknown < UNKNOWN_SPENT ? [n.unknown] : [],
  )
  return waiting.length === 0 ? undefined : RETRY_MS[Math.min(...waiting) - 1]
}

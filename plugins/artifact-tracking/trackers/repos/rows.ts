import { GLOBAL_DEFAULTS } from '../../core/lib/global-config'
import { stampedTurn, withSpan } from '../../core/lib/turn-span'
import { REPOS_DEFAULTS, type ReposConfig } from './config'
import type { RepoMode } from './hints'
import type { RepoVisit } from './tracker'
import type { RepoRecord } from './types'

/** The slot value as rows. The family stores Json, so a value that is not a list reads as none. */
export const asRepoRows = (v: readonly RepoRecord[] | undefined): RepoRecord[] =>
  Array.isArray(v) ? (v as RepoRecord[]) : []

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** A row without mode (stored by an older version) reads as read. */
const modeOf = (r: RepoRecord): RepoMode => (r.mode === 'edit' ? 'edit' : 'read')

const sameRow = (a: RepoRecord, b: RepoRecord): boolean =>
  a.name === b.name &&
  modeOf(a) === modeOf(b) &&
  a.root === b.root &&
  a.branch === b.branch &&
  a.firstSeen === b.firstSeen &&
  a.lastSeen === b.lastSeen &&
  a.firstTurn === b.firstTurn &&
  a.lastTurn === b.lastTurn &&
  sameList(a.touchedBy, b.touchedBy)

/** `cur` and `other` in one row: cur's agents first. The newer record (tie: cur) wins; a missing field never wipes one. */
function mergeRow(cur: RepoRecord, other: RepoRecord): RepoRecord {
  const [older, newer] = other.lastSeen > cur.lastSeen ? [cur, other] : [other, cur]
  const touchedBy = [...new Set([...cur.touchedBy, ...other.touchedBy])]
  const defined = Object.fromEntries(Object.entries(newer).filter(([, v]) => v !== undefined))
  const next: RepoRecord = {
    ...older,
    ...defined,
    touchedBy: sameList(touchedBy, cur.touchedBy) ? cur.touchedBy : touchedBy,
    firstSeen: Math.min(cur.firstSeen, other.firstSeen),
    lastSeen: Math.max(cur.lastSeen, other.lastSeen),
  }
  if (modeOf(cur) === 'edit' || modeOf(other) === 'edit') next.mode = 'edit'
  const spanned = withSpan(next, cur, other) // `defined` took the newer copy's turns: the span is of both
  return sameRow(spanned, cur) ? cur : spanned
}

/**
 * Merge stored or carried rows into the live list by key. firstSeen is the minimum, lastSeen the maximum, the agents
 * a union (cur first). The row with the greater lastSeen (tie: cur) gives name, root and branch; a missing root or
 * branch never wipes a known one. Edit wins over read, whatever the order. Returns `cur` itself when nothing changes.
 */
export function mergeRepoRows(cur: RepoRecord[], added: readonly RepoRecord[]): RepoRecord[] {
  if (added.length === 0) return cur
  let out = cur
  for (const row of added) {
    const i = out.findIndex(r => r.key === row.key)
    if (i < 0) {
      out = [...out, row]
      continue
    }
    const merged = mergeRow(out[i]!, row)
    if (merged === out[i]) continue
    out = out.slice()
    out[i] = merged
  }
  return out
}

/** Keeps `maxRepos` rows with the greatest lastSeen (in their order) and the first `maxRepoAgents` agents of each. */
export function capRepoRows(
  rows: RepoRecord[],
  caps: Pick<ReposConfig, 'maxRepos' | 'maxRepoAgents'> = REPOS_DEFAULTS,
): RepoRecord[] {
  let out = rows
  if (out.length > caps.maxRepos) {
    const keep = new Set(
      out
        .map((r, i) => ({ i, at: r.lastSeen }))
        .sort((a, b) => b.at - a.at || b.i - a.i)
        .slice(0, caps.maxRepos)
        .map(x => x.i),
    )
    out = out.filter((_, i) => keep.has(i))
  }
  if (out.some(r => r.touchedBy.length > caps.maxRepoAgents))
    out = out.map(r =>
      r.touchedBy.length > caps.maxRepoAgents ? { ...r, touchedBy: r.touchedBy.slice(0, caps.maxRepoAgents) } : r,
    )
  return out
}

/**
 * Record one visit. An older visit never moves the name, root, branch or lastSeen of a newer row. A visit within
 * `tickMs` (`global.refresh.tickMs`) of lastSeen leaves lastSeen alone, so a burst of tool calls is one write. A ref
 * visit (no root) does not rename a row that git already named. Edit wins over read, whatever the age of the visit.
 * `turn` (issue #133) is the ordinal of the turn that made the visit: it stamps `firstTurn` and `lastTurn`, and a turn the
 * row has not seen yet is a change though `lastSeen` stays. Returns `rows` itself when no field changes.
 */
export function upsertRepoRows(
  rows: readonly RepoRecord[],
  visit: RepoVisit & { at: number; turn?: number },
  tickMs: number = GLOBAL_DEFAULTS.refresh.tickMs,
): RepoRecord[] {
  const i = rows.findIndex(r => r.key === visit.key)
  if (i < 0) {
    return [
      ...rows,
      {
        key: visit.key,
        name: visit.name,
        ...(visit.root !== undefined ? { root: visit.root } : {}),
        ...(visit.branch !== undefined ? { branch: visit.branch } : {}),
        mode: visit.mode,
        touchedBy: [visit.touchedBy],
        firstSeen: visit.at,
        lastSeen: visit.at,
        ...(visit.turn !== undefined ? { firstTurn: visit.turn, lastTurn: visit.turn } : {}),
      },
    ]
  }
  const cur = rows[i]!
  const touchedBy = cur.touchedBy.includes(visit.touchedBy) ? cur.touchedBy : [...cur.touchedBy, visit.touchedBy]
  const mode: RepoMode = modeOf(cur) === 'edit' || visit.mode === 'edit' ? 'edit' : 'read'
  const next: RepoRecord = { ...cur, touchedBy, mode, firstSeen: Math.min(cur.firstSeen, visit.at) }
  if (visit.at >= cur.lastSeen) {
    if (visit.root !== undefined) next.root = visit.root
    if (visit.branch !== undefined) next.branch = visit.branch
    if (visit.root !== undefined || cur.name === '') next.name = visit.name
    if (visit.at - cur.lastSeen >= tickMs) next.lastSeen = visit.at
  }
  const stamped = visit.turn === undefined ? next : stampedTurn(next, visit.turn)
  if (sameRow(stamped, cur)) return rows as RepoRecord[]
  const out = rows.slice()
  out[i] = stamped
  return out
}

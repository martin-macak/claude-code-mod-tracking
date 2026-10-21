// Parts of a pane section that the trackers share: a toned cell, the cells and the badges of an item row, the sort of the
// items of a section and the small texts a row shows. A row writes the columns that every row of the pane table shares
// (`ColumnId`), so a tracker declares no columns of its own. Pure: no `$`, no I/O, no tracker named.
// The tones and the cell order keep the text the pane drew before L6, so the /track text stays byte-identical (decision G2).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.
// Design study of issue #63, section 5.3: the crosswalk of the old cell ids to the shared columns.

import type { Effective, ReasonSet, StoredItem } from '../interfaces/items'
import type { Cell, CellId, TreeRow } from '../interfaces/view'
import { byLevel, markerOf } from './levels'

export type Tone = 'plain' | 'ok' | 'warn' | 'bad' | 'dim'

const FG = { ok: 'success', warn: 'warning', bad: 'error' } as const

/** A cell with the color token of a tone. `plain` has none. */
export function toned(text: string, tone: Tone = 'plain'): Cell {
  if (tone === 'dim') return { text, dim: true }
  return tone === 'plain' ? { text } : { text, fg: FG[tone] }
}

/** The mark cell: the glyph of the level, dimmed when a rule gave the level. No level gives an empty cell. */
export function levelCell(level: Effective): Cell {
  return { text: markerOf(level.level), ...(level.auto ? { dim: true } : {}) }
}

/**
 * What an item row says. `key` fills the name column, `title` the description, `type` and `status` their own columns.
 * `extra` and `mark` are badges of the extras column. Only the fields a section shows are set.
 */
export type RowText = {
  key: string
  href?: string
  title: string
  type?: string
  status?: string
  tone?: Tone
  /** The first badge of the extras column. */
  extra?: string
  extraTone?: Tone
  /** The badge after the others. It draws dimmed. */
  mark?: string
  /** Where a title too long for its column is cut. Default: the clip of the column. `middle` keeps both ends of a branch or a path. */
  titleClip?: 'end' | 'middle'
  /** Where a type too long for its column is cut. Default: the clip of the column. */
  typeClip?: 'end' | 'middle'
}

/** The cells of the text columns. `href` sits on the name cell, when there is a link. */
export function textCells(t: RowText): Partial<Record<CellId, Cell>> {
  return {
    name: { text: t.key, ...(t.href ? { href: t.href } : {}) },
    description: { text: t.title, ...(t.titleClip ? { clip: t.titleClip } : {}) },
    ...(t.type !== undefined ? { type: { text: t.type, ...(t.typeClip ? { clip: t.typeClip } : {}) } } : {}),
    ...(t.status !== undefined ? { status: toned(t.status, t.tone) } : {}),
  }
}

/** The badges of the extras column: the extra, then the mark. A badge with no text is left out. */
export function extrasOf(t: RowText): readonly Cell[] {
  return [
    ...(t.extra ? [toned(t.extra, t.extraTone)] : []),
    ...(t.mark ? [{ text: t.mark, dim: true } satisfies Cell] : []),
  ]
}

/**
 * The row of an item: the control cell, the text cells and the badges. A person can always mark an item row. `dismiss`
 * is false for a row inside an item, e.g. a child node.
 */
export function itemRow(o: {
  id: string
  owner: string
  level: Effective
  text: RowText
  dismiss: boolean
  /** Why the item is tracked: the `reasons` of its record. */
  reasons?: ReasonSet
  dim?: boolean
  children?: readonly TreeRow[]
}): TreeRow {
  const kids = o.children !== undefined && o.children.length > 0 ? o.children : undefined
  const extras = extrasOf(o.text)
  return {
    id: o.id,
    owner: o.owner,
    cells: { control: levelCell(o.level), ...textCells(o.text) },
    ...(extras.length > 0 ? { extras } : {}),
    ...(kids ? { children: kids, expandedByDefault: true } : {}),
    can: { dismiss: o.dismiss, priority: true },
    ...(o.reasons ? { reasons: o.reasons } : {}),
    ...(o.dim ? { dim: true } : {}),
  }
}

/** The items by level, higher first, then by the first sighting, then by `thenBy`. A new array. */
export function sortedByLevel<T extends { key: string; firstSeen: number }>(
  items: readonly T[],
  levelOf: (key: string) => Effective,
  thenBy: (a: T, b: T) => number = () => 0,
): T[] {
  return [...items].sort(
    (a, b) => byLevel(levelOf(a.key).level, levelOf(b.key).level) || a.firstSeen - b.firstSeen || thenBy(a, b),
  )
}

/** The latest `refreshedAt` among the items, or undefined when none was refreshed. */
export function lastRefreshOf(items: readonly { refreshedAt?: number }[]): number | undefined {
  let last: number | undefined
  for (const i of items)
    if (i.refreshedAt !== undefined && (last === undefined || i.refreshedAt > last)) last = i.refreshedAt
  return last
}

/** `↳#7,#9 ` for an item that PR bodies name (spec 10.3), else an empty string. */
export function viaPrefix(via: readonly string[] | undefined): string {
  const numbers = (via ?? []).flatMap(k => {
    const n = /#(\d+)$/.exec(k)?.[1]
    return n === undefined ? [] : [`#${n}`]
  })
  return numbers.length > 0 ? `↳${numbers.join(',')} ` : ''
}

/** The first and the last turn of each item that a turn tracked, by item key. */
export function turnSpans(items: readonly StoredItem[]): ReadonlyMap<string, NonNullable<TreeRow['turns']>> {
  const out = new Map<string, NonNullable<TreeRow['turns']>>()
  for (const i of items) {
    const first = i.firstTurn
    const last = i.lastTurn
    if (typeof first === 'number' && typeof last === 'number') out.set(i.key, { first, last })
  }
  return out
}

/**
 * The rows with `turns` set from their item (issue #69): the row id is the item key. A row of no item, or of an item no
 * turn tracked, is left as it is; the same array comes back when no row changes.
 */
export function withTurns(
  rows: readonly TreeRow[],
  spans: ReadonlyMap<string, NonNullable<TreeRow['turns']>>,
): readonly TreeRow[] {
  if (spans.size === 0) return rows
  let changed = false
  const out = rows.map(row => {
    const turns = spans.get(row.id)
    const children = row.children === undefined ? undefined : withTurns(row.children, spans)
    if (turns === undefined && children === row.children) return row
    changed = true
    return { ...row, ...(turns !== undefined ? { turns } : {}), ...(children !== undefined ? { children } : {}) }
  })
  return changed ? out : rows
}

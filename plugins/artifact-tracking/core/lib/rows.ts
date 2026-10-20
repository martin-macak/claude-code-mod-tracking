// Parts of a pane section that the trackers share: the width words of a column, the prio column, a toned cell, the cells of
// an item row, the sort of the items of a section and the small texts a row shows. Pure: no `$`, no I/O, no tracker named.
// The tones and the cell order keep the text the pane drew before L6, so the /track text stays byte-identical (decision G2).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.

import type { Effective, ReasonSet } from '../interfaces/items'
import type { Cell, ColumnDef, TreeRow } from '../interfaces/view'
import { byLevel, markerOf } from './levels'

type Width = ColumnDef['width']

/** `c(min, max)`: as wide as the content, clamped. A bound left out is not set. */
export const content = (min?: number, max?: number): Width => ({
  kind: 'content',
  ...(min !== undefined ? { min } : {}),
  ...(max !== undefined ? { max } : {}),
})
/** `f(min)`: takes the room that is left. */
export const flex = (min: number): Width => ({ kind: 'flex', min })
/** `x(n)`: `n` cells. */
export const fixed = (cells: number): Width => ({ kind: 'fixed', cells })

/** The mark column of an item section: one cell, no header. */
export const PRIO_COLUMN: ColumnDef = { id: 'prio', header: '', width: fixed(1) }

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

/** What an item row says, by column id. Only the fields a section shows are set. */
export type RowText = {
  key: string
  href?: string
  title: string
  type?: string
  status?: string
  tone?: Tone
  extra?: string
  extraTone?: Tone
  /** A short marker after the other cells. It draws dimmed. */
  mark?: string
}

/** The cells of the text columns. `href` sits on the key cell, when there is a link. */
export function textCells(t: RowText): Record<string, Cell> {
  return {
    key: { text: t.key, ...(t.href ? { href: t.href } : {}) },
    title: { text: t.title },
    ...(t.type !== undefined ? { type: { text: t.type } } : {}),
    ...(t.status !== undefined ? { status: toned(t.status, t.tone) } : {}),
    ...(t.extra !== undefined ? { extra: toned(t.extra, t.extraTone) } : {}),
    ...(t.mark !== undefined ? { mark: { text: t.mark, dim: true } } : {}),
  }
}

/**
 * The row of an item: the mark cell and the text cells. A person can always mark an item row. `dismiss` is false for a
 * row inside an item, e.g. a child node.
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
  return {
    id: o.id,
    owner: o.owner,
    cells: { prio: levelCell(o.level), ...textCells(o.text) },
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

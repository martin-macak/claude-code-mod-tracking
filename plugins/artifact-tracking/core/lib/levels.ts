// Priority levels: the order of the levels, their markers and the merge of manual marks. Pure.
// A record's `priority` is the person's manual mark only. Absent means no mark.
// Moved from `hooks/model/priority.ts` in plan L5, Task 2. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9.

import type { Level, Priority } from '../interfaces/items'

export type { Level, Priority } from '../interfaces/items'

const LEVELS: readonly Level[] = ['top', 'high', 'normal', 'low']

/** The place of a level in LEVELS: lower is higher. No level reads as `normal`. */
export const rankOf = (level: Level | undefined): number => LEVELS.indexOf(level ?? 'normal')

/** Sort comparator, higher level first. Equal levels give 0, so a stable sort keeps the old order. */
export const byLevel = (a: Level | undefined, b: Level | undefined): number => rankOf(a) - rankOf(b)

const MARKER = { top: '★', high: '▲', normal: '', low: '▽' } as const

/** The glyph of a level. Normal, and no level, have none. */
export const markerOf = (level: Level | undefined): '' | '★' | '▲' | '▽' => MARKER[level ?? 'normal']

/** Two manual marks of one item: a set mark beats no mark, and of two set marks the higher wins. */
export function mergePriority(a: Priority | undefined, b: Priority | undefined): Priority | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return rankOf(a) <= rankOf(b) ? a : b
}

/** `node` with `priority` set, or without the key when it is undefined. */
export function withPriority<T extends { priority?: Priority }>(node: T, priority: Priority | undefined): T {
  const out = { ...node }
  if (priority === undefined) delete out.priority
  else out.priority = priority
  return out
}

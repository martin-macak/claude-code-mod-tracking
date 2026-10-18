// The record algebra: the fields every item record shares, and (from plan Task 4) the generic merge over item kinds.
// Task 1 adds the two types. Task 4 adds the functions.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 1 and Task 4.

import type { Priority, StoredItem } from '../interfaces/items'

/** `not-found`: the tool says the item does not exist (or no permission). `failed`: the last refresh failed. */
export type ItemError = { kind: 'not-found' | 'failed'; message: string; at: number }

/**
 * What every item record shares, over the contract's `StoredItem`. A kind adds its own flat fields.
 * `key`, `firstSeen` and `lastSeen` are writable here: the merge folds records in place on a copy.
 */
export type BaseRecord = StoredItem & {
  key: string
  firstSeen: number
  lastSeen: number
  /** The person's manual mark. A rule's level never lands in a record. */
  priority?: Priority
  url: string
  /** Display text: Markdown label, title, or host + path. */
  label: string
  sources: string[]
  seenCount: number
  refreshedAt?: number
  error?: ItemError
  /** Keys of discovered items whose body names this one. Absent when none. */
  via?: string[]
}

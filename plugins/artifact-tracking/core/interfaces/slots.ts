// Data slots: the unit Persistence stores and the lifecycle carries across a session switch. Types only.
// A slot is one tracker's data, or the item list. `persist: false` makes it run-scoped: it goes to `v2:run`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.6 and 5.13. Plan decisions D1, D2, D9.

import type { Json } from './items'

/** One slot of the data core stores per session. */
export interface DataSlot {
  readonly id: string
  /** False: run-scoped. The slot goes to `v2:run`, and a switch carries it before the persisted slots load. */
  readonly persist: boolean
  /** The live value. undefined: the slot holds nothing. */
  read(): Promise<Json | undefined>
  /** True when the value holds nothing worth a write. */
  empty(v: Json | undefined): boolean
  /** Merges the stored copy under the live value. Returns what the session should hold. */
  settle(live: Json | undefined, stored: Json | undefined): Promise<Json | undefined>
  /** Puts a value into the live slot. `carry`: from the leaving session. `load`: from the stored copy of the new one. */
  restore(value: Json, how: 'carry' | 'load'): Promise<void>
  /** Empties the live slot. `/track clear`. */
  clear?(): Promise<void>
}

/** The stored copy of one session (`v2:s:<id>`): the persisted slot values, keyed by slot id. */
export type SessionCopy = { readonly [slot: string]: Json }

/** Written by `session.end` into `v2:run`. The switch that follows reads it. */
export type PendingEnd = { reason: string; fromId: string; at: number }

/** The run-scoped record (`v2:run`). */
export type RunCopy = { pendingEnd?: PendingEnd; run?: Readonly<Record<string, Json>> }

/** What `session.end` keeps of the leaving session: every slot, settled. The switch carries from it. */
export type Snapshot = { from: string; slots: Readonly<Record<string, Json | undefined>> }

// The level binding of the legacy draw path: the effective level of every record for `view.ts`. A thin delegation over the
// staged resolver in `core/infra/priority.ts` and the rules of the shipped kinds. The sections of the trackers carry the
// levels themselves (`core/lib/rows.ts`); L6 deletes this file with the draw path.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.1. Plan: L5 Task 15.

import { effectiveLevels as levelsOf } from '../../core/infra/priority'
import type { Effective, Json } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { KindTable } from '../../core/lib/records'
import { KINDS } from '../../trackers'
import type { ItemRecord } from './view'

export type { Effective }

const table: KindTable = category => KINDS.find(kind => kind.category === category)

/** What the auto rules read: the session repo, and the branch of this session's cwd. `currentBranch` absent: detached HEAD or not known yet. */
export type LevelContext = { sessionRepo?: RepoRef | null; currentBranch?: string }

/** The level of every record, by key: the manual mark, else the rules of its kind in stages, else none. */
export function effectiveLevels(records: readonly ItemRecord[], ctx: LevelContext): Map<string, Effective> {
  const facts: Record<string, Json | undefined> = {
    'session.repo': (ctx.sessionRepo ?? undefined) as unknown as Json | undefined,
    'auto.branches': ctx.currentBranch === undefined ? undefined : { current: ctx.currentBranch },
  }
  return levelsOf(records, table, { read: <T extends Json>(name: string) => facts[name] as T | undefined })
}

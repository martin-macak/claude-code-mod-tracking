import { read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

export const TA = 'ta2'
export type Tracker = { readonly id: string }
export const trackers: readonly Tracker[] = [{ id: 'github' }, { id: 'jira' }]

// A StateFamily member: inline literal plugin and key at the call site, computed id (taken from a tracker object).
export async function bump($: EngineInterface, tracker: Tracker): Promise<number> {
  await update($, { plugin: 'lifecycle-mod', key: 'slots', id: tracker.id } as const, s => ({ n: (s?.n ?? 0) + 1 }))
  return (await read($, { plugin: 'lifecycle-mod', key: 'slots', id: tracker.id } as const))?.n ?? -1
}

export async function peek($: EngineInterface, tracker: Tracker): Promise<number | null> {
  return (await read($, { plugin: 'lifecycle-mod', key: 'slots', id: tracker.id } as const))?.n ?? null
}

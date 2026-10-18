import type { On } from 'claude-code'
import { read, update } from 'claude-code'

export type TrackerLike = { readonly id: string }

/** A StateFamily member: literal plugin and key, computed id. */
export const slot = (id: string) => ({ plugin: 'g13', key: 'slots', id }) as const

export function installA(on: On, tracker: TrackerLike): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await update($, slot(tracker.id), s => ({ n: (s?.n ?? 0) + 1 }))
    return { deny: `${tracker.id}=${(await read($, slot(tracker.id)))?.n}` }
  })
}

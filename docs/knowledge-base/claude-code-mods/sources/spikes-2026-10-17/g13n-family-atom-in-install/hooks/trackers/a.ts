import type { On } from 'claude-code'
import { atom, read, update } from 'claude-code'

export type TrackerLike = { readonly id: string }

export function installA(on: On, tracker: TrackerLike): void {
  const slot = atom({ plugin: 'g13', key: 'slots', id: tracker.id } as const, { n: 0 })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await update($, slot, s => ({ n: s.n + 1 }))
    return { deny: `${tracker.id}=${(await read($, slot)).n}` }
  })
}

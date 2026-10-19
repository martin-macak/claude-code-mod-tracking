import type { On } from 'claude-code'
import { atom, read, update } from 'claude-code'

export type Tracker = { readonly id: string; readonly tool: string }

/** Each tracker file would do this with its own typed slice and its own id. */
export function installSlot(on: On, tracker: Tracker): void {
  const slot = atom({ plugin: 'g13', key: 'slots', id: tracker.id } as const, null as unknown)
  on('tool.call', { tool: tracker.tool as 'Bash' }, async ($, e, next) => {
    await update($, slot, v => ({ n: ((v as { n?: number } | undefined)?.n ?? 0) + 1 }))
    return { deny: `${tracker.id}=${JSON.stringify(await read($, slot))}` }
  })
}

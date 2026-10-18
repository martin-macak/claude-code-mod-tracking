import type { On } from 'claude-code'
import { read, update } from 'claude-code'

export type TrackerLike = { readonly id: string }

export function installA(on: On, tracker: TrackerLike): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ref = { plugin: 'g13', key: 'slots', id: tracker.id } as const
    await update($, ref, s => ({ n: (s?.n ?? 0) + 1 }))
    return { deny: `${tracker.id}=${(await read($, ref))?.n}` }
  })
}

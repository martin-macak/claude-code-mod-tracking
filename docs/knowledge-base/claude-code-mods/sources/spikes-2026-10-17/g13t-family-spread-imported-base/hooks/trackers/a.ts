import type { On } from 'claude-code'
import { read, update } from 'claude-code'
import { SLOTS } from './base'

type TrackerLike = { readonly id: string }

export function installA(on: On, tracker: TrackerLike): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await update($, { ...SLOTS, id: tracker.id }, s => ({ n: ((s as { n?: number } | undefined)?.n ?? 0) + 1 }))
    return { deny: `${tracker.id}=${JSON.stringify(await read($, { ...SLOTS, id: tracker.id }))}` }
  })
}

import type { Register } from 'claude-code'
import { read, update } from 'claude-code'
import { SlotHolder } from './trackers/a'

const holder = new SlotHolder('github')

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await update($, holder.slot, s => ({ n: s.n + 1 }))
    return { deny: `n=${(await read($, holder.slot)).n}` }
  })
}

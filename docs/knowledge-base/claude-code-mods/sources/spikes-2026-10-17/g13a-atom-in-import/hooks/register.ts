import type { Register } from 'claude-code'
import { read, update } from 'claude-code'
import { aRef } from './trackers/a'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await update($, aRef, n => n + 1)
    return { deny: `a=${await read($, aRef)}` }
  })
}

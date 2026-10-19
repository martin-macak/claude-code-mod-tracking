import type { On } from 'claude-code'
import { atom, read, update } from 'claude-code'

const aRef = atom({ plugin: 'g13', key: 'a' } as const, 0)

export function installA(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await update($, aRef, n => n + 1)
    return { deny: `a=${await read($, aRef)}` }
  })
}

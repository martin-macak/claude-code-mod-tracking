import type { On } from 'claude-code'
import { atom, read } from 'claude-code'

const zRef = atom({ plugin: 'g13', key: 'zzz' } as const, 0)

export function installA(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: `z=${await read($, zRef)}` }))
}

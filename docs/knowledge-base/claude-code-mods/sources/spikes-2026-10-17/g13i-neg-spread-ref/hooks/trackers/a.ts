import type { On } from 'claude-code'
import { atom, read } from 'claude-code'

const BASE = { plugin: 'g13' } as const
const aRef = atom({ ...BASE, key: 'a' } as const, 0)

export function installA(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: `a=${await read($, aRef)}` }))
}

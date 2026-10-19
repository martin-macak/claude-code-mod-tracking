import type { On } from 'claude-code'
export function installB(on: On): void {
  on('tool.call', { tool: 'Read' }, ($, e, next) => ({ deny: 'b' }))
}

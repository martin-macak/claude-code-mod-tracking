import type { On } from 'claude-code'
export function installA(on: On): void {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => ({ deny: 'a' }))
}

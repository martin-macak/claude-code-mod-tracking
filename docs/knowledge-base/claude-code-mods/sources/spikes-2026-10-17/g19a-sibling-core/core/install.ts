import type { On } from 'claude-code'
import { answer } from './x'

export function installCore(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: `core:${answer(2)}:${await $.session.id()}` }))
}

import type { On } from 'claude-code'
import { nowOf } from './util'

export function installK(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: `k2:${await nowOf($)}` }))
}

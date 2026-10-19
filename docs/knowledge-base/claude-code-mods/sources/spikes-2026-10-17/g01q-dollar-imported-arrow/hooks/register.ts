import type { Register } from 'claude-code'
import { nowOf } from './trackers/util'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: `q:${await nowOf($)}` }))
}

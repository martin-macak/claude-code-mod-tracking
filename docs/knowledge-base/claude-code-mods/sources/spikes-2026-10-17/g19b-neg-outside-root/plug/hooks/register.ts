import type { Register } from 'claude-code'
import { answer } from '../../shared/x'

export const register: Register = on => {
  on('tool.call', { tool: 'Read' }, ($, e, next) => ({ deny: `outside:${answer(1)}` }))
}

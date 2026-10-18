import type { Register } from 'claude-code'
import { answer } from '../core/x'
import { installCore } from '../core/install'

export const register: Register = on => {
  installCore(on)
  on('tool.call', { tool: 'Read' }, ($, e, next) => ({ deny: `direct:${answer(1)}` }))
}

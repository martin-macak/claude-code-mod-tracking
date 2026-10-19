import type { Register } from 'claude-code'
import { bumpA, readA } from './trackers/a'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await bumpA($)
    return { deny: `a=${await readA($)}` }
  })
}

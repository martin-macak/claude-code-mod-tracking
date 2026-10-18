import type { Register } from 'claude-code'
import { aRef } from './trackers/a'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cur = await $.state.get(aRef)
    await $.state.set(aRef, (cur.value ?? 0) + 1)
    return { deny: `a=${(await $.state.get(aRef)).value}` }
  })
}

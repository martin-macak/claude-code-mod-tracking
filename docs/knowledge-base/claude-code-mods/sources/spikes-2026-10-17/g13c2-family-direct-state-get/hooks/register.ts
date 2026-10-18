import type { Register } from 'claude-code'
import { slot } from './trackers/a'

const tracker = { id: 'github' }

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cur = await $.state.get(slot(tracker.id))
    await $.state.set(slot(tracker.id), { n: (cur.value?.n ?? 0) + 1 })
    return { deny: `n=${(await $.state.get(slot(tracker.id))).value?.n}` }
  })
}

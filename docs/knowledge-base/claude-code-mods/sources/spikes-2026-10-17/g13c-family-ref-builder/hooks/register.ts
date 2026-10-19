import type { Register } from 'claude-code'
import { read } from 'claude-code'
import { installA, slot } from './trackers/a'

const tracker = { id: 'github' }

export const register: Register = on => {
  installA(on, tracker)
  on('tool.call', { tool: 'Read' }, async ($, e, next) => ({ deny: `read=${(await read($, slot(tracker.id)))?.n}` }))
}

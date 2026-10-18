import type { EngineInterface, Register } from 'claude-code'
import { doorsOf, toolMap } from '../core/lib/bus'
import { tracker as a } from '../trackers/a'
import { tracker as b } from '../trackers/b'

const TRACKERS = [a, b]
const DOORS = doorsOf(TRACKERS)
const TOOLS = toolMap(TRACKERS)
const WORK = '<SPIKES>/hl/work/f.txt'
const seen: string[] = []

async function note($: EngineInterface, line: string): Promise<void> {
  seen.push(line)
  await $.store.set('seen', JSON.stringify(seen))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'bus probe' })
    return next(e)
  })
  on('command.run', { command: 'probe' }, async ($, e) => {
    seen.length = 0
    await $.tool.call({ tool: 'Read', file_path: WORK })
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'bus-row' }] } })
    await $.clock.sleep(400)
    await $.store.set('seen', JSON.stringify(seen))
    return { text: 'bus done: ' + seen.length + ' lines' }
  })
  on('tool.call', async ($, e, next) => {
    const ids = TOOLS.get(e.tool)
    if (ids) for (const id of ids) await note($, `tool.call ${e.tool} -> tracker ${id}`)
    return next(e)
  })
  on('session.append', { door: DOORS }, async ($, e, next) => {
    await note($, `session.append door=${e.door} -> bus (DOORS=${DOORS.join('|')})`)
    return next(e)
  })
}

// R-BUS: one matcherless on('tool.call') fans out to a Map of handlers keyed by e.tool.
// One on('session.append', { door: DOORS }) where DOORS is a same-file `as const` array.
import type { EngineInterface, Register } from 'claude-code'

const DOORS = ['tool-result', 'tool-message'] as const

type Ports = { record: (key: string, value: string) => Promise<void> }
type ToolHandler = (ports: Ports, e: { tool: string }) => Promise<void>

function portsOf($: EngineInterface): Ports {
  return { record: (key, value) => $.store.set(key, value) }
}

const HANDLERS = new Map<string, ToolHandler>([
  ['Read', (p, e) => p.record('fired:Read', `handler-read saw ${e.tool}`)],
  ['Bash', (p, e) => p.record('fired:Bash', `handler-bash saw ${e.tool}`)],
  ['Grep', (p, e) => p.record('fired:Grep', `handler-grep saw ${e.tool}`)],
  ['Edit', (p, e) => p.record('fired:Edit', `handler-edit saw ${e.tool}`)],
])

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const h = HANDLERS.get(e.tool)
    if (h) await h(portsOf($), e)
    return next(e)
  })

  on('session.append', { door: DOORS }, async ($, e, next) => {
    await portsOf($).record(`door:${e.door}`, 'seen')
    return next(e)
  })
}

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { Manager } from './core/manager'
import { portsOf } from './core/adapter'
import type { Ports } from './core/ports'

const count = atom({ plugin: 'g02b-ports-factory-in-import', key: 'count' } as const, 0)

function portsFor($: EngineInterface): Ports {
  return portsOf($, () => update($, count, n => n + 1), () => read($, count))
}

// Module state: lost on hot reload, rebuilt on the next use.
let manager: Manager | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Built ONCE per load, from the first hook's `$`.
    manager = new Manager(portsFor($))
    await manager.start()
    return next(e)
  })
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    // Variant: ports rebuilt per hook (cheap closures), no module variable.
    const ports = portsFor($)
    return { deny: `per-hook:${await ports.session.id()}:${await ports.clock.now()}` }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A different hook. It uses the manager (and the ports of the session.start `$`).
    const out = await manager?.onTool()
    return { deny: out ?? 'no manager' }
  })
}

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { Manager } from './core/manager'
import type { Ports } from './core/ports'

const count = atom({ plugin: 'g02-ports-object', key: 'count' } as const, 0)

/** Same-file top-level function. The ONE place that spells `$` for the ports. */
function portsOf($: EngineInterface): Ports {
  return {
    state: {
      get: () => read($, count),
      bump: () => update($, count, n => n + 1),
    },
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
    },
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    run: (argv, init) => $.process.run(argv, init),
    session: { id: () => $.session.id(), cwd: () => $.session.cwd() },
  }
}

// Module state: lost on hot reload, rebuilt on the next use.
let manager: Manager | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Built ONCE per load, from the first hook's `$`.
    manager = new Manager(portsOf($))
    await manager.start()
    return next(e)
  })
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    // Variant: ports rebuilt per hook (cheap closures), no module variable.
    const ports = portsOf($)
    return { deny: `per-hook:${await ports.session.id()}:${await ports.clock.now()}` }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A different hook. It uses the manager (and the ports of the session.start `$`).
    const out = await manager?.onTool()
    return { deny: out ?? 'no manager' }
  })
}

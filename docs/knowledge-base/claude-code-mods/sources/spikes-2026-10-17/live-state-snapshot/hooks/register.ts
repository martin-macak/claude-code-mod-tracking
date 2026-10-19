import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { holder } from '../core/holder'
import { Manager } from '../core/manager'
import type { Ports } from '../core/ports'
import { installAll } from './trackers/index'

const hits = atom({ plugin: 'live-probe', key: 'hits' } as const, 0)

function portsOf($: EngineInterface): Ports {
  return {
    state: {
      get: () => read($, hits),
      bump: () => update($, hits, n => n + 1),
    },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    fs: { read: path => $.fs.read(path), write: (path, text) => $.fs.write(path, text), exists: path => $.fs.exists(path) },
    clock: { now: () => $.clock.now(), after: (ms, fn) => $.clock.after(ms, fn), every: (ms, fn) => $.clock.every(ms, fn) },
    run: argv => $.process.run(argv),
    session: { id: () => $.session.id(), cwd: () => $.session.cwd() },
  }
}

export const register: Register = on => {
  installAll(on)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spike', description: 'run the spike probe' })
    holder.manager = new Manager(portsOf($))
    holder.manager.start()
    return next(e)
  })
}

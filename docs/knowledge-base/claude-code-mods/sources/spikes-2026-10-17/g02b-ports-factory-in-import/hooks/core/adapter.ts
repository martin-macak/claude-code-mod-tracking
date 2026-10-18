import type { EngineInterface } from 'claude-code'
import type { Ports } from './ports'

/** An imported plain function takes `$` and returns closures over it. */
export function portsOf($: EngineInterface, bump: () => Promise<number>, get: () => Promise<number>): Ports {
  return {
    state: { get, bump },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    fs: { read: path => $.fs.read(path), write: (path, text) => $.fs.write(path, text), exists: path => $.fs.exists(path) },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    run: (argv, init) => $.process.run(argv, init),
    session: { id: () => $.session.id(), cwd: () => $.session.cwd() },
  }
}

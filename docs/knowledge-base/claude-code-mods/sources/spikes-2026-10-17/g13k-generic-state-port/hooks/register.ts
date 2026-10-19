import type { Atom, EngineInterface, Register } from 'claude-code'
import { read, update } from 'claude-code'
import { aRef } from './trackers/a'

type StatePort = {
  read<T>(a: Atom<T>): Promise<T>
  update<T>(a: Atom<T>, f: (v: T) => T): Promise<T>
}

function statePort($: EngineInterface): StatePort {
  return { read: a => read($, a), update: (a, f) => update($, a, f) }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const s = statePort($)
    await s.update(aRef, n => n + 1)
    return { deny: `a=${await s.read(aRef)}` }
  })
}

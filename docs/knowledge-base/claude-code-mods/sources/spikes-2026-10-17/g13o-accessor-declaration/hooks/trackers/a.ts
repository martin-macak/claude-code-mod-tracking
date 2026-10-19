import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'

const aRef = atom({ plugin: 'g13', key: 'a' } as const, 0)

export function bumpA($: EngineInterface): Promise<number> {
  return update($, aRef, n => n + 1)
}
export function readA($: EngineInterface): Promise<number> {
  return read($, aRef)
}

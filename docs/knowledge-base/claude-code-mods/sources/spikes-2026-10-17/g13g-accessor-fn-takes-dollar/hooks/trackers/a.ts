import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'

const aRef = atom({ plugin: 'g13', key: 'a' } as const, 0)

export const bumpA = ($: EngineInterface): Promise<number> => update($, aRef, n => n + 1)
export const readA = ($: EngineInterface): Promise<number> => read($, aRef)

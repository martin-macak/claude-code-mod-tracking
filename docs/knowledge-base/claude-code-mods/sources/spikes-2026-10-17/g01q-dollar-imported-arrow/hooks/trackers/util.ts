import type { EngineInterface } from 'claude-code'
export const nowOf = ($: EngineInterface): Promise<number> => $.clock.now()

import type { EngineInterface, Register } from 'claude-code'

const nowOf = ($: EngineInterface): Promise<number> => $.clock.now()

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: `r:${await nowOf($)}` }))
}

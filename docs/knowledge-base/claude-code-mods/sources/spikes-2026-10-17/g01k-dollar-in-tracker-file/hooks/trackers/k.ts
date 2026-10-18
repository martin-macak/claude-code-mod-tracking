import type { EngineInterface, On } from 'claude-code'
import type { Core } from './core'

// A top-level function of THIS (imported) file may take `$`.
async function nowOf($: EngineInterface): Promise<number> {
  return $.clock.now()
}

export function installK(on: On, core: Core): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const t = await nowOf($)
    core.note(`bash@${t}`)
    return { deny: `k-fired:${core.hits.length}:${t}` }
  })
}

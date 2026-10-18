import type { On } from 'claude-code'
export function installB(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    return { ...r, bSaw: e.tool } as never
  })
}

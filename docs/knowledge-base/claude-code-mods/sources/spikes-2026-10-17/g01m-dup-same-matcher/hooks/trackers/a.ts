import type { On } from 'claude-code'
export const seen: string[] = []
export function installA(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    seen.push('a')
    const r = await next(e); return { ...r, aSaw: e.tool } as never
  })
}

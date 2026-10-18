import type { On } from 'claude-code'

export const seen: string[] = []

export function install(on: On): void {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    seen.push('a:Bash')
    return { deny: 'a-fired' }
  })
}

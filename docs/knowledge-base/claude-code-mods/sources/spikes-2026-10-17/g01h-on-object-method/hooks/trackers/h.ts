import type { On } from 'claude-code'

export const trackerH = {
  install(on: On): void {
    on('tool.call', { tool: 'Bash' }, ($, e, next) => ({ deny: 'h-fired' }))
  },
}

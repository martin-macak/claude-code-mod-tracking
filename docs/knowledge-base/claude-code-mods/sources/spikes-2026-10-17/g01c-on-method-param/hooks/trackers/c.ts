import type { On } from 'claude-code'

export class TrackerC {
  attach(reg: On): void {
    reg('tool.call', { tool: 'Bash' }, ($, e, next) => ({ deny: 'c-fired' }))
  }
}

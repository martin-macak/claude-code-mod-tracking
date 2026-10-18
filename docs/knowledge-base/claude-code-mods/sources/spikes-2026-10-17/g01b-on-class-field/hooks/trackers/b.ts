import type { On } from 'claude-code'

export class TrackerB {
  constructor(private readonly on: On) {}
  attach(): void {
    this.on('tool.call', { tool: 'Bash' }, ($, e, next) => ({ deny: 'b-fired' }))
  }
}

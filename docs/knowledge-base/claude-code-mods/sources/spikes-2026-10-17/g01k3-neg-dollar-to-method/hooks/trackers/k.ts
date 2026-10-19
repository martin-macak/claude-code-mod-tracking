import type { EngineInterface, On } from 'claude-code'

class Svc {
  async now($: EngineInterface): Promise<number> {
    return $.clock.now()
  }
}
const svc = new Svc()

export function installK(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: `k3:${await svc.now($)}` }))
}

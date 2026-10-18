import type { EngineInterface, Register } from 'claude-code'
class Item { async refresh($: EngineInterface) { return $.process.run(['gh', '--version']) } }
async function top($: EngineInterface) { return $.process.run(['gh', '--version']) }
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { await new Item().refresh($); await top($); return next(e) })
}

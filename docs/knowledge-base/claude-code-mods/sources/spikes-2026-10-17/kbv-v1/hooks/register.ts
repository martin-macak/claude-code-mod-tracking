import type { Register } from 'claude-code'
import { GhItem, GhTool } from './tools'
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const tool = new GhTool((argv) => $.process.run(argv))
    const item = new GhItem('#1', tool)
    await item.refresh()
    return next(e)
  })
}

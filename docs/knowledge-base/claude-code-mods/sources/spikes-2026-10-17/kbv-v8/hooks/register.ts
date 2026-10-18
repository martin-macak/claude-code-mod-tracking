import type { Register } from 'claude-code'
import { GhTool } from './tools'
let tool: GhTool | undefined
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    tool = new GhTool((argv) => $.process.run(argv))
    $.clock.after(100, () => { void tool?.probe() })
    return next(e)
  })
}

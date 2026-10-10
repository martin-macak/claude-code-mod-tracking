import type { EngineInterface, Register } from 'claude-code'
import { GhTool } from './tools'
import type { Run } from './tools'
function runnerOf($: EngineInterface): Run { return (argv) => $.process.run(argv) }
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { await new GhTool(runnerOf($)).probe(); return next(e) })
}

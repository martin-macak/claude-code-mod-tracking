import type { EngineInterface, Register } from 'claude-code'
let held: EngineInterface | undefined
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { held = $; await held.process.run(['gh', '--version']); return next(e) })
}

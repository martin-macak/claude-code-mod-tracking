import type { Register } from 'claude-code'
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { const run = $.process.run; await run(['gh', '--version']); return next(e) })
}

import type { Register } from 'claude-code'
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { const p = $.process; await p.run(['gh', '--version']); return next(e) })
}

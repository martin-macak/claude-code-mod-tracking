import type { Register } from 'claude-code'
import { Thing } from './cls'
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { await new Thing($).go(); return next(e) })
}

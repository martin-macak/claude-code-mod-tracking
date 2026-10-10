import type { Register } from 'claude-code'
export const register: Register = (on) => {
  on('session.append', ($, e, next) => next(e))
  on('session.append', ($, e, next) => next(e))
}

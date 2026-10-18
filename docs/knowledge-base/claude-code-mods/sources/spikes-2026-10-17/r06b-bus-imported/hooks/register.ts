import type { Register } from 'claude-code'
import { DOORS } from '../core/lib/doors'

export const register: Register = on => {
  on('session.append', { door: DOORS }, async ($, e, next) => {
    await $.store.set(`door:${e.door}`, 'seen')
    return next(e)
  })
}

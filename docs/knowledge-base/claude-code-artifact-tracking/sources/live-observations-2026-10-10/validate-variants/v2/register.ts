import type { Register } from 'claude-code'
import { probe } from './helper'
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { await probe($); return next(e) })
}

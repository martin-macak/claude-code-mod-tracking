import type { Register } from 'claude-code'
import { cellWidth } from './cell-width'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cellWidth('日本語 ✅ x')
    return next(e)
  })
}

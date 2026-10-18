import type { Register } from 'claude-code'
import { camelCase } from 'lodash'

export const register: Register = (on) => {
  on('session.start', ($, e, next) => {
    camelCase('a b')
    return next(e)
  })
}

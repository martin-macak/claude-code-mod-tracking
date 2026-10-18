import type { Register } from 'claude-code'
import { doorsOf } from '../core/lib/doors'
import { tracker as a } from '../trackers/a'
import { tracker as b } from '../trackers/b'

const TRACKERS = [a, b]
const DOORS = doorsOf(TRACKERS)

export const register: Register = on => {
  on('session.append', { door: DOORS }, async ($, e, next) => {
    await $.store.set(`door:${e.door}`, 'seen')
    return next(e)
  })
}

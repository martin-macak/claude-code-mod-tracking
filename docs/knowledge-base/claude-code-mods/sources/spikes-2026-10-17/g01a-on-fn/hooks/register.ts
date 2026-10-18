import type { Register } from 'claude-code'
import { install } from './trackers/a'

export const register: Register = (on) => {
  install(on)
}

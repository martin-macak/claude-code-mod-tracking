import type { Register } from 'claude-code'
import { install } from './trackers/e'

export const register: Register = (on) => {
  install(on)
}

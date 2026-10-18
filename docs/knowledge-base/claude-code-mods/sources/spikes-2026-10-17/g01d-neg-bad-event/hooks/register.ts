import type { Register } from 'claude-code'
import { install } from './trackers/d'

export const register: Register = (on) => {
  install(on)
}

import type { Register } from 'claude-code'
import { installAll } from './trackers/index'

export const register: Register = (on) => {
  installAll(on)
}

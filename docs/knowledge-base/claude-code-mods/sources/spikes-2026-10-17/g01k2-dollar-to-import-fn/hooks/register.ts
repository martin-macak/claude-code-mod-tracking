import type { Register } from 'claude-code'
import { installK } from './trackers/k'

export const register: Register = (on) => {
  installK(on)
}

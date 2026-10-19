import type { Register } from 'claude-code'
import { installK } from './trackers/k'
import { Core } from './trackers/core'

const core = new Core()

export const register: Register = (on) => {
  installK(on, core)
}

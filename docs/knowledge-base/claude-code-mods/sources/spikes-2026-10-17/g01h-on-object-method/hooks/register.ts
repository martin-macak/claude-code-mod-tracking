import type { Register } from 'claude-code'
import { trackerH } from './trackers/h'

export const register: Register = (on) => {
  trackerH.install(on)
}

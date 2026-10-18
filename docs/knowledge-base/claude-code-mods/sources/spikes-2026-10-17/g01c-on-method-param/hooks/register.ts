import type { Register } from 'claude-code'
import { TrackerC } from './trackers/c'

export const register: Register = (on) => {
  new TrackerC().attach(on)
}

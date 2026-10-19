import type { Register } from 'claude-code'
import { TrackerB } from './trackers/b'

export const register: Register = (on) => {
  new TrackerB(on).attach()
}

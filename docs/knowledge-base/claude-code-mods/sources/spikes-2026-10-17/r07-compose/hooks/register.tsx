import type { Register } from 'claude-code'
import { installA } from '../trackers/a'
import { installB } from '../trackers/b'

export const register: Register = on => {
  installA(on)
  installB(on)
}

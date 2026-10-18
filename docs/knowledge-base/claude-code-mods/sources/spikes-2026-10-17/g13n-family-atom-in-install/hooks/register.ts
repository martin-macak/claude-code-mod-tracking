import type { Register } from 'claude-code'
import { installA } from './trackers/a'

export const register: Register = on => {
  installA(on, { id: 'github' })
}

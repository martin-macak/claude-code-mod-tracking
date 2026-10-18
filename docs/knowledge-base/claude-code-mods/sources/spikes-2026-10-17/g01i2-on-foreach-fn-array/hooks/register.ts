import type { Register } from 'claude-code'
import { INSTALLERS } from './trackers/index'

export const register: Register = (on) => {
  INSTALLERS.forEach(install => install(on))
}

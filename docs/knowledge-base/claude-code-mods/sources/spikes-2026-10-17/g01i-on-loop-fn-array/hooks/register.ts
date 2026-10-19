import type { Register } from 'claude-code'
import { INSTALLERS } from './trackers/index'

export const register: Register = (on) => {
  for (const install of INSTALLERS) install(on)
}

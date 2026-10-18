import type { Register } from 'claude-code'
import { installA } from './trackers/a'
import { installB } from './trackers/b'

export const register: Register = (on, options) => {
  // One tracker failing to install must not stop the rest.
  try {
    installA(on)
  } catch {
    // logged elsewhere
  }
  if (options.withB === true) installB(on)
}

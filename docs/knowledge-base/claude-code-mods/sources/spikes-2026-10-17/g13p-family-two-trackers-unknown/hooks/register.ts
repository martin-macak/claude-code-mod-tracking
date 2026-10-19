import type { Register } from 'claude-code'
import { installSlot } from './trackers/slot'

export const register: Register = on => {
  installSlot(on, { id: 'github', tool: 'Bash' })
  installSlot(on, { id: 'jira', tool: 'Read' })
}

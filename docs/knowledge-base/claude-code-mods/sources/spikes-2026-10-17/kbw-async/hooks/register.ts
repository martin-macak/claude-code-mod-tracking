import type { Register } from 'claude-code'

export const register: Register = async (on) => {
  await Promise.resolve()
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'async-registered' }))
}

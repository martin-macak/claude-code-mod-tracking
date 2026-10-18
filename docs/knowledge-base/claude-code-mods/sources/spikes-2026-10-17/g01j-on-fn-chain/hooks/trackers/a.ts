import type { On } from 'claude-code'

// An arrow const is a function too.
export const installA = (on: On): void => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => ({ deny: 'a-fired' }))
}

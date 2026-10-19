import type { On } from 'claude-code'

export function installB(on: On): void {
  // `$` is the hook's own parameter. Calls on it are literal.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const id = await $.session.id()
    return { deny: `b-fired:${id}` }
  })
  on('turn.complete', ($, e, next) => next(e))
}

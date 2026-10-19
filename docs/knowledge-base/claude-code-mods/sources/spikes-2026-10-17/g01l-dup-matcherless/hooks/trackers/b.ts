import type { On } from 'claude-code'
export function installB(on: On): void {
  on('turn.complete', ($, e, next) => next(e))
}

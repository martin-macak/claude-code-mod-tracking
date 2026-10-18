import type { On } from 'claude-code'
export function installA(on: On): void {
  on('turn.complete', ($, e, next) => next(e))
}

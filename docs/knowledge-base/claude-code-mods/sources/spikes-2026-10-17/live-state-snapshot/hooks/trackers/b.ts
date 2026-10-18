import type { On } from 'claude-code'

export const seen: string[] = []

export function installB(on: On): void {
  on('turn.complete', ($, e, next) => {
    seen.push('b')
    return next(e)
  })
}

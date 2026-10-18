import type { On } from 'claude-code'

export function install(on: On): void {
  // @ts-expect-error misspelled on purpose
  on('tool.calls', ($, e, next) => next(e))
}

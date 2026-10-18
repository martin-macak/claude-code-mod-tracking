import type { On } from 'claude-code'

const EVENT = 'tool.call' as const

export function install(on: On): void {
  on(EVENT, ($, e, next) => next(e))
}

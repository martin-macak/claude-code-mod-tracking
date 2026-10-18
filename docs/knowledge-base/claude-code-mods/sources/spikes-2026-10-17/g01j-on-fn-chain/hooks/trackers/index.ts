import type { On } from 'claude-code'
import { installA } from './a'
import { installB } from './b'

/** One registry function. A new tracker adds one line here. */
export function installAll(on: On): void {
  installA(on)
  installB(on)
}

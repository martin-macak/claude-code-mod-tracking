import type { On } from 'claude-code'
import { installA } from './a'
import { installB } from './b'

export function installAll(on: On): void {
  installA(on)
  installB(on)
}

import type { On } from 'claude-code'
import { installA } from './a'

export const INSTALLERS: ((on: On) => void)[] = [installA]

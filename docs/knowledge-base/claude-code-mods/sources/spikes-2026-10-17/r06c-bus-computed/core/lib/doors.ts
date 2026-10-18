import type { SessionAppendDoor } from 'claude-code'
export function doorsOf(trackers: readonly { doors: readonly SessionAppendDoor[] }[]): SessionAppendDoor[] {
  return [...new Set(trackers.flatMap(t => t.doors))]
}

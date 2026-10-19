// Small text helpers any tracker may use: short ages, the note of a tool, compact agent ids, first line, error message.
// Moved from the pane code and `core/infra/tool.ts` in plan L5, Task 2. Pure.

import type { ToolStatus } from '../../types'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Short age: `now`, `12s`, `4m`, `2h`, `3d`. */
export function ago(ms: number): string {
  if (!(ms >= SECOND)) return 'now'
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

/** What a section header says about the tool behind it. First match wins. */
export function toolNote(t: ToolStatus, now: number, lastRefresh?: number): string {
  if (t.available === false) return 'not installed'
  if (t.available === null) return 'checking…'
  if (t.loggedIn === false) return 'not logged in'
  if (t.breaker === 'open') return `paused ${ago(Math.max(0, (t.openUntil ?? now) - now))}`
  if (lastRefresh !== undefined) {
    const age = ago(Math.max(0, now - lastRefresh))
    return age === 'now' ? 'refreshed just now' : `refreshed ${age} ago`
  }
  return 'ready'
}

const AGENT_ID = /(agent-)([0-9a-f]{8})[0-9a-f]+/g
const RUN_ID = /wf_([A-Za-z0-9-]+)-(\d+)(?![\w-])/g

/**
 * Agent ids compact to 8 hex after `agent-`. A workflow run id keeps 6 characters between `wf_` and the last
 * `-<digits>`, since a run id can hold `-` (spec 10.3). Any other hex string stays as it is.
 */
export function compactIds(text: string): string {
  return text
    .replace(AGENT_ID, '$1$2')
    .replace(RUN_ID, (m, body: string, n: string) => (body.length > 6 ? `wf_${body.slice(0, 6)}-${n}` : m))
}

export function firstLine(s: string): string {
  return s.trim().split('\n')[0]?.trim() ?? ''
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

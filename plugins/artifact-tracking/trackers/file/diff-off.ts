// Whether the diff mode of the file preview can work in a folder (issue #254, R16 of the design study, and M1 of the review of #289). R16
// says that without a repo or a base the mode is off, with the reason: a dim Button on the key line, and a toast at a press (core draws
// both from `PreviewMode.enabled` and `reason`, issue #57, L2). `modes()` is pure and runs at each drawing, so it cannot ask git. Git is
// asked in two places that can run it: the diff itself, and a probe that the view starts apart from its hook. Each finding that there
// is no repo or no base is kept as the fact `file.diffOff`: `{ [folder]: { reason, at } }`, and `modes()` reads it.
// The answer is a guess about a world that changes outside this session (a repo that comes, a base that is fetched), so it holds
// `OFF_TTL_MS`. A git command of Claude that can change the answer (`GIT_REPO_CMD`) and a session switch withdraw all of them. A diff
// that finds a base clears its folder, and each visit of the view asks again. Until the probe ends, nothing is known and the mode is
// on: a press asks git and says the reason in a notice, as before. Pure but for the facts it is given.

import type { Json } from '../../core/interfaces/items'
import type { FactsPort } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import { FACT_DIFF_OFF } from './facts'

/** How long an answer holds. Long enough that no drawing asks, short enough that a repo that came in the meantime is found. */
export const OFF_TTL_MS = 60_000
/** At most this many folders are kept: the newest. A session that previews files of more folders asks again for the oldest. */
const MAX_FOLDERS = 64

/** A shell command that can make a repo or a base, or change the branch the repo is on: `git init`, `clone`, `fetch`, `pull`, `remote`, `checkout`, `switch`. */
export const GIT_REPO_CMD = /\bgit\s+(?:-C\s+\S+\s+)?(?:init|clone|fetch|pull|remote|checkout|switch)\b/

/** One folder: the words a person reads, and when git said so (wall time, as `ViewContext.now` and `clock.wall()` tell it). */
type Entry = { readonly reason: string; readonly at: number }

/** The folders of the fact, in the order they were written. A part of another shape is left out. */
function entriesOf(facts: Pick<FactsPort, 'read'>): Map<string, Entry> {
  const v = facts.read<Json>(FACT_DIFF_OFF)
  const out = new Map<string, Entry>()
  if (!isRecord(v)) return out
  for (const [folder, e] of Object.entries(v)) {
    if (isRecord(e) && typeof e.reason === 'string' && typeof e.at === 'number')
      out.set(folder, { reason: e.reason, at: e.at })
  }
  return out
}

const fresh = (e: Entry, now: number): boolean => now - e.at < OFF_TTL_MS

/** Why the diff mode of `folder` is off, or `undefined` when nothing known says so (no answer, or one older than `OFF_TTL_MS`). Reads only. */
export function offReason(facts: Pick<FactsPort, 'read'>, folder: string, now: number): string | undefined {
  const e = entriesOf(facts).get(folder)
  return e !== undefined && fresh(e, now) ? e.reason : undefined
}

/** Git said that `folder` has no diff, for `reason`. The answers that are old by now go, and so do the oldest past `MAX_FOLDERS`. */
export function markOff(facts: FactsPort, folder: string, reason: string, now: number): void {
  const live = [...entriesOf(facts)].filter(([f, e]) => f !== folder && fresh(e, now))
  const next: [string, Entry][] = [...live.slice(-(MAX_FOLDERS - 1)), [folder, { reason, at: now }]]
  facts.publish(FACT_DIFF_OFF, Object.fromEntries(next))
}

/** Git found a base for `folder`: its answer goes. With no folder, every answer goes (a git command, a session switch). */
export function clearOff(facts: FactsPort, folder?: string): void {
  if (folder === undefined) {
    facts.publish(FACT_DIFF_OFF, undefined)
    return
  }
  const entries = entriesOf(facts)
  if (!entries.delete(folder)) return
  facts.publish(FACT_DIFF_OFF, entries.size === 0 ? undefined : Object.fromEntries(entries))
}

// The strip under an answer (issue #69, P2): what it says and which surface shows it. Pure: no state, no engine.
// `text` is a notice row that a `turn.complete` hook adds under the duration line (design study S7, L33 and L199). It never
// reaches the model (S8). `interactive` draws the counts and an open Button on the duration line itself, which the engine
// raises on the terminal only, and only for a turn that ended with an answer: an aborted turn has no duration line (S9,
// L118 to L134). `refusal` and `error` do have a duration line (live check, issue #167, 2.1.316), but are treated like an abort here.
// Wording: "seen again", never "updated".
// Spec: issue #69, the design study "Show what each turn tracked", section 5 ("Strip") and the owner decisions of 2026-10-21.

import type { TurnStripMode } from '../interfaces/config'
import type { DurationStrip, TurnLedger, TurnRecord } from '../interfaces/turns'
import { countOf } from './turn-entries'
import { bandCounts } from './turn-text'
import { recordByRow } from './turns'

const tracked = (r: TurnRecord): boolean => {
  const { added, seen } = countOf(r)
  return added + seen > 0
}

/** `+3 new · 1 seen again · /track turn 7`. Undefined when the turn tracked nothing: there is no line to show. */
export function stripLine(r: TurnRecord): string | undefined {
  return tracked(r) ? `${bandCounts(r)} · /track turn ${r.ord}` : undefined
}

/**
 * The text the `turn.complete` hook returns when it adds its line. `below` is what the hooks beneath it gave (`next(e)`),
 * `answer` the answer of the turn. The engine's own text is the answer (design study, L181 and L192), so a different, non-empty
 * text is the notice of another plugin: it stays, and the line follows it after ` · `. Anything else is replaced.
 * Not a line break: the engine draws a break in a text as a replacement glyph (U+FFFD), not as a new line
 * (live check, issue #167, 2.1.316).
 */
export function withLine(below: string, answer: string, line: string): string {
  return below === answer || below === '' ? line : `${below} · ${line}`
}

/**
 * The text a `turn.complete` hook returns for the turn that ended, or undefined for none (the hook then returns what `next`
 * gave, and the engine adds no row). `off`: none. `text`: the line, whatever the end of the turn was. `interactive`: the
 * duration line carries the strip of a turn that ended with an answer and has a duration row, so only the other turns get
 * the text line: an aborted turn (no duration line), `refusal` and `error` (treated alike), and an answer whose duration row
 * never reached the mod. `undefined` for the record: a wake has none of its own.
 */
export function stripText(r: TurnRecord | undefined, mode: TurnStripMode): string | undefined {
  if (r === undefined || mode === 'off') return undefined
  if (mode === 'interactive' && carried(r)) return undefined
  return stripLine(r)
}

/** The duration line of an answer is drawn with this record's strip, so no text line is needed. */
const carried = (r: TurnRecord): boolean => r.end === 'answer' && r.durationRow !== undefined

/**
 * The strip for the `TurnDuration` line with this `requestId` (the uuid of its `turn_duration` row): the counts and the
 * ordinal. Undefined for a row no record knows, for a turn that tracked nothing and for a turn that did not end with an
 * answer (its text line was returned instead, so the strip shows once).
 */
export function durationStrip(l: TurnLedger, requestId: string): DurationStrip | undefined {
  const r = recordByRow(l, requestId)
  return r !== undefined && r.end === 'answer' && tracked(r) ? { ord: r.ord, counts: bandCounts(r) } : undefined
}

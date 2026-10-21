// The words of the turn ledger (issue #69): the reply of `/track turn [n]` and the counts the band shows. Pure: no state,
// no clock but the one the caller passes, no tracker named.
// Spec: issue #69, the design study (section 5, "Band" and "/track turn [n]"). Wording: "seen again", never "updated":
// #62 has a core reason `updated` that means Claude changed the item (owner decision of 2026-10-21).

import type { TurnEntry, TurnLedger, TurnRecord } from '../interfaces/turns'
import { countOf } from './turn-entries'
import { MAX_TURNS, PROMPT_CHARS } from './turns'

/** `/track turn` with a word that is no turn number. */
export const TURN_USAGE = 'Usage: /track turn [n]'

/** `+3 new · 1 seen again`: the parts that are more than 0, for the band. */
export function bandCounts(r: Pick<TurnRecord, 'new' | 'seen' | 'moreNew' | 'moreSeen'>): string {
  const { added, seen } = countOf(r)
  return [...(added > 0 ? [`+${added} new`] : []), ...(seen > 0 ? [`${seen} seen again`] : [])].join(' · ')
}

/** `3 new, 1 seen again`, or `nothing tracked`, for the head of the reply. */
function headCounts(r: TurnRecord): string {
  const { added, seen } = countOf(r)
  const parts = [...(added > 0 ? [`${added} new`] : []), ...(seen > 0 ? [`${seen} seen again`] : [])]
  return parts.length > 0 ? parts.join(', ') : 'nothing tracked'
}

/** `HH:MM` of a time in the zone of the machine. */
export const clockOf = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What the reply reads beside the ledger. */
export interface TurnTextEnv {
  /** The id of the current session: a record of another id reads "earlier session". */
  readonly session: string
  /** The words of an item for its line: the type, key and title of its row, or what the ledger knows when no row is left. */
  label(e: TurnEntry): string
  /** `HH:MM` of an epoch time. */
  time?(ms: number): string
}

/** The longest an item's words get before the reason column. A longer text is cut. */
const LABEL_WIDTH = 56

const cut = (text: string): string => (text.length > LABEL_WIDTH ? `${text.slice(0, LABEL_WIDTH - 1)}…` : text)

/** The lines of one list: a kind word, the item's words padded to `width`, the reason, then the count of what did not fit. */
function lines(
  kind: 'new' | 'again',
  list: readonly TurnEntry[],
  more: number | undefined,
  labels: ReadonlyMap<TurnEntry, string>,
  width: number,
): string[] {
  const out = list.map(
    e => `  ${kind.padEnd(5)}  ${labels.get(e)!.padEnd(width)}  ${e.r}${e.late === true ? ' · late (subagent)' : ''}`,
  )
  return more !== undefined && more > 0 ? [...out, `  ${kind.padEnd(5)}  and ${more} more not listed`] : out
}

/**
 * The reply of `/track turn [n]`. `n` absent: the newest turn. A turn the ledger no longer keeps, or has not reached, says so.
 * The head names the turn, how it ended, when, the first 60 characters of the prompt and the counts; a line follows for
 * each item, the ones the turn added first, then the ones it saw again, each with its #62 reason.
 */
export function turnText(ledger: TurnLedger, n: number | undefined, env: TurnTextEnv): string {
  const last = ledger.turns.at(-1)
  if (last === undefined) return 'No turn tracked yet.'
  const rec = n === undefined ? last : ledger.turns.find(r => r.ord === n)
  if (rec === undefined) {
    const first = ledger.turns[0]!.ord
    if (n !== undefined && n < first)
      return `Turn ${n} is no longer kept (the last ${MAX_TURNS} turns are, from turn ${first}).`
    return `No turn ${n} yet. The last is turn ${last.ord}.`
  }
  const time = env.time ?? clockOf
  const state = rec.end ?? (ledger.open?.ord === rec.ord ? 'running' : undefined)
  const prompt =
    rec.prompt === undefined ? undefined : `"${rec.prompt}${[...rec.prompt].length >= PROMPT_CHARS ? '…' : ''}"`
  const wakes = rec.wakes === undefined ? undefined : `${rec.wakes} ${rec.wakes === 1 ? 'wake' : 'wakes'}`
  const head = [
    `Turn ${rec.ord}${rec.session === env.session ? '' : ' (earlier session)'}`,
    ...(state !== undefined ? [state] : []),
    time(rec.startedAt),
    ...(prompt !== undefined ? [prompt] : []),
    headCounts(rec),
    ...(wakes !== undefined ? [wakes] : []),
  ].join(' · ')
  // One column of words for both lists, so the reasons line up.
  const labels = new Map([...rec.new, ...rec.seen].map(e => [e, cut(env.label(e))] as const))
  const width = Math.max(0, ...[...labels.values()].map(l => l.length))
  return [
    head,
    ...lines('new', rec.new, rec.moreNew, labels, width),
    ...lines('again', rec.seen, rec.moreSeen, labels, width),
  ].join('\n')
}

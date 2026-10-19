// Safe text for prompt lines. A title, a label or a file name comes from an outside system and may hold a newline, ANSI
// codes, invisible characters or an instruction. These helpers make it plain, short and quoted. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 1, S5, S6, S9, S17, S18.

import type { StoredItem } from '../interfaces/items'
import type { ViewContext } from '../interfaces/view'
import { urlParts } from './links'

export const ELLIPSIS = '…'
/** The longest line of the prompt text. The composer clips to it, and `promptLine` keeps its quoted text inside it. */
export const PROMPT_LINE_MAX = 200
/** The longest fact of a line. */
const FACT_MAX = 30

/** CSI: `ESC [`, parameter bytes, intermediate bytes, one final byte. */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
/** OSC: `ESC ]` up to BEL or `ESC \`. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
/** Control characters and the line and paragraph separators: they would start a new line. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu
/** Zero-width, bidi and tag characters: they hide text from a reader. */
const INVISIBLE = /\p{Cf}/gu

/**
 * One line of plain text. Removes ANSI first (each CSI or OSC becomes one space), then turns control characters and the
 * line and paragraph separators into a space, deletes the invisible format characters, collapses space runs and trims.
 * The order matters: ESC is a control character itself.
 */
export function stripControl(s: string): string {
  return s.replace(CSI, ' ').replace(OSC, ' ').replace(BREAKS, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim()
}

/**
 * At most `max` code points, never a split surrogate pair. A cut text ends in `…`, which counts inside `max`. The input
 * is cut to `2 * max` code units before it is spread, so a huge string stays cheap: those units hold at least `max`
 * code points, and a string longer than that always holds more than `max`.
 */
export function clip(s: string, max: number): string {
  if (!(max >= 1)) return ''
  const long = s.length > 2 * max
  const points = [...(long ? s.slice(0, 2 * max) : s)]
  // A cut at the end of `slice` may leave half a pair as the last element. It sits at index `max - 1` or later: never kept.
  return long || points.length > max ? points.slice(0, max - 1).join('') + ELLIPSIS : s
}

/** `clip(stripControl(s), max)`. */
export function plain(s: string, max: number): string {
  return clip(stripControl(s), max)
}

/**
 * The text of an outside system as data: plain, at most `max` characters inside the quotes, and in double quotes. An
 * inner double quote becomes a single one, so the text cannot end its own quote. Empty text gives an empty string.
 */
export function quoted(s: string, max: number): string {
  const text = plain(s, max).replace(/"/g, "'")
  return text === '' ? '' : `"${text}"`
}

/** What can hold a secret in a URL text: from the first `?` or `#` on, and the userinfo before an `@` of the authority. */
const TAIL = /[?#].*$/su
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i

/**
 * The host (with the port) and the path of a URL. No userinfo, query, fragment or trailing slash: a query can hold a
 * token. A URL with no host (`file:`, `mailto:`) or one that `URL` rejects (a port out of range) has no host and path
 * to show: its text is cut at the first `?` or `#`, loses its userinfo and is clipped, whatever its scheme.
 */
export function hostAndPath(url: string): string {
  const parts = urlParts(url)
  return parts && parts.host !== '' ? parts.host + parts.path : plain(url.replace(TAIL, '').replace(USERINFO, '$1'), 80)
}

const RANK: ReadonlyMap<string, number> = new Map([
  ['top', 0],
  ['high', 1],
  ['normal', 2],
  ['low', 3],
])
const NORMAL = 2

/**
 * The order of the pane: the person's mark (`top`, `high`, none or `normal`, `low`), then `firstSeen` ascending, then
 * `key`. A new array. `firstSeen` never changes, so an item seen again does not move. No kind rule applies.
 */
export function orderForPrompt<T extends { key: string; firstSeen: number; priority?: string }>(
  items: readonly T[],
): T[] {
  const rank = (i: T): number => RANK.get(i.priority ?? '') ?? NORMAL
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || a.firstSeen - b.firstSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

/** The facts as ` (a, b)`, or an empty string when none is left. */
function factsText(facts: readonly string[]): string {
  // A fact may be outside text: it cannot close its parentheses or open a quote.
  const shown = facts.map(f => plain(f.replace(/["()]/g, ' '), FACT_MAX)).filter(f => f !== '')
  return shown.length > 0 ? ` (${shown.join(', ')})` : ''
}

const points = (s: string): number => [...s].length

/**
 * One line of a tracker: the head (`<id>: <ref>`), the facts in parentheses and the text of the outside system, quoted.
 * A fact is plain, has no parenthesis or quote and is at most 30 characters. `text` is raw and `textMax` its cap: the
 * quoted text gets at most the room that the head and the facts leave in `PROMPT_LINE_MAX`, so the closing quote
 * survives the composer's clip. With no room, or no text, the line ends after the facts. A part that is empty leaves its
 * separator out.
 */
export function promptLine(head: string, facts: readonly string[], text = '', textMax = 0): string {
  const shown = factsText(facts)
  const room = Math.min(textMax, PROMPT_LINE_MAX - points(head) - points(shown) - 3)
  const quote = room < 1 || text === '' ? '' : quoted(text, room)
  return head + shown + (quote === '' ? '' : ` ${quote}`)
}

/**
 * The records of a kind that the person has not dismissed, in prompt order. `decode` is the `decode` of the item kind:
 * it drops what the kind does not own and what is not shaped like the kind. The prompt of a tracker maps the result.
 */
export function promptRecords<T extends { key: string; firstSeen: number; priority?: string }>(
  ctx: Pick<ViewContext, 'items' | 'isDismissed'>,
  decode: (item: StoredItem) => T | null,
): T[] {
  return orderForPrompt(
    ctx.items.flatMap(item => {
      const rec = decode(item)
      return rec && !ctx.isDismissed(rec.key) ? [rec] : []
    }),
  )
}

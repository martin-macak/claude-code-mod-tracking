// Safe text for prompt lines. A title, a label or a file name comes from an outside system and may hold a newline, ANSI
// codes, invisible characters or an instruction. These helpers make it plain, short and quoted. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 1, S5, S6, S9.

export const ELLIPSIS = '…'

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

/** The host (with the port) and the path of a URL. No userinfo, query, fragment or trailing slash: a query can hold a token. */
export function hostAndPath(url: string): string {
  try {
    const u = new URL(url)
    if (u.host !== '') return u.host + u.pathname.replace(/\/+$/, '')
  } catch {
    // Not a URL: shown as plain text below.
  }
  return plain(url, 80)
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

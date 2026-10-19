// Text masking for the scan: blank what a pattern must not read, keep every offset. Pure.
// Moved from `hooks/scan/refs.ts` in plan L5, Task 2 (spec 5.9, capture step 3).

export const blanks = (s: string): string => ' '.repeat(s.length)

/** Blank fenced code blocks (``` and ~~~). An unclosed fence runs to the end. */
export function maskFences(text: string): string {
  const lines = text.split('\n')
  let fence: { ch: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && m[2]!.trim() === '') fence = null
      lines[i] = blanks(line)
    } else if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
      fence = { ch: m[1]![0]!, len: m[1]!.length }
      lines[i] = blanks(line)
    }
  }
  return lines.join('\n')
}

/** Blank inline code spans: a backtick run closes at the next run of the same length. Linear. */
export function maskCodeSpans(text: string): string {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue
    let j = i
    while (text[j] === '`') j++
    runs.push([i, j - i])
    i = j - 1
  }
  if (runs.length < 2) return text
  const next = new Array<number>(runs.length).fill(-1)
  const last = new Map<number, number>()
  for (let k = runs.length - 1; k >= 0; k--) {
    const len = runs[k]![1]
    next[k] = last.get(len) ?? -1
    last.set(len, k)
  }
  let out = ''
  let pos = 0
  for (let k = 0; k < runs.length; k++) {
    const close = next[k]!
    if (close === -1) continue
    const from = runs[k]![0]
    const to = runs[close]![0] + runs[close]![1]
    out += text.slice(pos, from) + blanks(text.slice(from, to))
    pos = to
    k = close // runs inside the span are consumed
  }
  return out + text.slice(pos)
}

/** Replace what a bare `#N` must not be read from with spaces of equal length. */
export function maskForBare(text: string): string {
  return maskCodeSpans(maskFences(text))
    .replace(/<[^<>\s]*>/g, blanks)
    .replace(/\]\([^()\n]*\)?/g, blanks)
    .replace(/https?:\/\/\S+/g, blanks)
}

/**
 * `text` with each span replaced by spaces of equal length. Spans may touch, overlap or come in any order; one outside
 * the text changes nothing. One pass: the cost does not grow with the number of spans times the length of the text.
 */
export function maskSpans(text: string, spans: readonly { start: number; end: number }[]): string {
  if (spans.length === 0) return text
  const sorted = spans
    .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(text.length, end) }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const { start, end } of sorted) {
    if (end <= pos) continue
    const from = Math.max(start, pos)
    out += text.slice(pos, from) + blanks(text.slice(from, end))
    pos = end
  }
  return out + text.slice(pos)
}

// The text of a diff, as the preview of a file draws it (issue #254, L3 of #57). Pure: no state, no I/O.
// `Code format="diff"` reads hunks: the `diff --git`, `index`, `---` and `+++` lines do not draw, and a hunk that a cut left with its
// old header does not parse (design study G13). So the source starts at the first hunk header, the caps cut at the border of a hunk, and
// a hunk that must be cut inside gets a new header for the lines that it keeps. The source never passes the cap of characters.
// Design study R17 and G13: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787

import { clip } from '../../core/lib/text'

/** `@@ -a[,b] +c[,d] @@ text`: the header of one hunk. The trailing text (the function context) is kept as git wrote it. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/
/** A line of a diff that is not a line of the file: the marker git puts after a last line with no newline. It costs no line of a cap. */
const isMarker = (line: string): boolean => line.startsWith('\\')
/** The least body lines that a hunk after whole ones must keep to be cut inside: a smaller part is no view of it, so the cut falls on its border. */
const MIN_PARTIAL = 5
/** The least characters that a line cut short keeps: its prefix and one more. A smaller part is no sight of the line. */
const MIN_CLIP = 2

const linesOf = (text: string): string[] => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The hunks of raw `git diff` output of one file, from the first hunk header on, or `undefined` when there is none (empty output, a
 * binary marker, a change of mode). The pane draws one path, and git writes more than one block for it when the type of the file
 * changed (a file that became a link has a deletion and an addition), so the hunks of every block with the header of the first block
 * that has hunks are joined. A block of another path is not drawn. A line of the file that looks like a header never starts or ends a
 * hunk, because a body line always has a prefix (a space, `+`, `-` or `\`).
 */
export function hunksOf(raw: string): string | undefined {
  const out: string[] = []
  let first: string | undefined
  let block: string | undefined
  let seen = false
  let mine = false
  for (const line of linesOf(raw)) {
    if (line.startsWith('diff --git ')) {
      block = line
      mine = false
    } else if (HUNK.test(line)) {
      if (!seen) first = block
      seen = true
      mine = block === first
      if (mine) out.push(line)
    } else if (mine) {
      out.push(line)
    }
  }
  return seen ? `${out.join('\n')}\n` : undefined
}

/** True when git says that the file is binary: `Binary files … differ`, or a binary patch. The words of git start a line; a line of a file has a prefix. */
export const isBinaryDiff = (raw: string): boolean => /^(?:Binary files .* differ|GIT binary patch)$/m.test(raw)

/** The added and the removed lines of the hunks (the lines of the file, so a body line `--- a` is a removed line). */
export function changesOf(hunks: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of linesOf(hunks)) {
    if (HUNK.test(line)) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

interface Hunk {
  readonly header: string
  readonly body: readonly string[]
}

function hunksIn(source: string): Hunk[] {
  const out: { header: string; body: string[] }[] = []
  for (const line of linesOf(source)) {
    if (HUNK.test(line)) out.push({ header: line, body: [] })
    else out.at(-1)?.body.push(line)
  }
  return out
}

/** The lines of a hunk that count against the cap of lines: its header and its body without the markers. */
const countedLines = (hunk: Hunk): number => 1 + hunk.body.filter(line => !isMarker(line)).length
/** The characters of lines with their newlines. A marker counts: the source holds it, and the cap of characters is the cap of the source. */
const charsOf = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0)

/** The header of a hunk that keeps `body`: its start lines as git wrote them, its counts from the lines that stay. */
function headerFor(header: string, body: readonly string[]): string {
  const m = HUNK.exec(header)
  if (m === null) return header
  const old = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const now = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length
  return `@@ -${m[1]},${old} +${m[2]},${now} @@${m[3]}`
}

export interface CutDiff {
  /** The hunks that stay, as text with a trailing newline. */
  readonly source: string
  /** True when the caps left something out. */
  readonly cut: boolean
  /** True when the last hunk shown was cut inside: its header counts the lines that stay. */
  readonly partial: boolean
  /** True when one line was cut short: a line that did not fit the cap of characters. */
  readonly lineCut: boolean
  /** The lines drawn and the lines of the diff, headers and body lines, markers left out. */
  readonly shownLines: number
  readonly totalLines: number
  readonly shownHunks: number
  readonly totalHunks: number
}

/** What stays of a hunk that does not fit: its body lines (markers among them), how many of them count, and whether the last was cut short. */
interface Part {
  readonly kept: readonly string[]
  readonly counted: number
  readonly clipped: boolean
}

/**
 * The first lines of `hunk` that fit `room`, what is left of the caps. The header is counted as it will be written: its counts can have
 * a digit more than git's, which leaves out the count of a hunk of one line. A line goes with the marker after it, and both count, so
 * the source stays within the cap. A line that does not fit ends the part, and the cut falls before it, except in two cases where
 * the cap of characters is all that stops it and the line is cut short to what is left (`MIN_CLIP`): no change shows yet (a hunk of
 * context lines and then a long changed line must not draw no change), or the line is over the cap by itself (`cap` is the whole cap
 * of characters). A line that only the lines before it keep from fitting stays out, with the border of the hunk.
 */
function partOf(hunk: Hunk, room: { lines: number; chars: number }, cap: number): Part {
  const header = headerFor(hunk.header, hunk.body).length + 1
  const kept: string[] = []
  let lines = 1
  let chars = header
  let counted = 0
  let changed = false
  let clipped = false
  for (let i = 0; i < hunk.body.length; i++) {
    const text = hunk.body[i] as string
    if (isMarker(text)) continue // a marker comes along with the line before it
    const next = hunk.body[i + 1]
    const marker = next !== undefined && isMarker(next) ? [next] : []
    const tail = marker.reduce((sum, line) => sum + line.length + 1, 0)
    if (lines + 1 > room.lines) break
    if (chars + text.length + 1 + tail > room.chars) {
      const space = room.chars - chars - 1 - tail
      if (space >= MIN_CLIP && (!changed || text.length + 1 + tail > cap - header)) {
        kept.push(clip(text, space), ...marker)
        counted++
        clipped = true
      }
      break
    }
    kept.push(text, ...marker)
    counted++
    lines++
    chars += text.length + 1 + tail
    changed ||= text.startsWith('+') || text.startsWith('-')
  }
  return { kept, counted, clipped }
}

/**
 * Cuts `hunks` (from `hunksOf`) to `maxLines` lines and `maxChars` characters. Whole hunks stay while they fit. The first hunk that
 * does not fit is cut inside when it is the first one, or when a good part of the caps is left (`MIN_PARTIAL` body lines): its header then
 * counts the lines that it keeps, so the hunk parses. Else the cut falls on its border. A line that does not fit the cap of characters
 * is cut short in the cases of `partOf`. The hunk that is cut always keeps its header and at least its first body line, even when the
 * cap of characters is too small for it (one character of the first line, the only case where the source passes the cap).
 */
export function cutDiff(hunks: string, maxLines: number, maxChars: number): CutDiff {
  const all = hunksIn(hunks)
  const totalLines = all.reduce((sum, h) => sum + countedLines(h), 0)
  const caps = { lines: Math.max(maxLines, 2), chars: Math.max(maxChars, 1) }
  const out: string[] = []
  let lines = 0
  let chars = 0
  let shownHunks = 0
  let lineCut = false
  let partial = false
  let cut = false
  for (const hunk of all) {
    const whole = [hunk.header, ...hunk.body]
    if (lines + countedLines(hunk) <= caps.lines && chars + charsOf(whole) <= caps.chars) {
      out.push(...whole)
      lines += countedLines(hunk)
      chars += charsOf(whole)
      shownHunks++
      continue
    }
    cut = true
    let part = partOf(hunk, { lines: caps.lines - lines, chars: caps.chars - chars }, caps.chars)
    const first = hunk.body.find(text => !isMarker(text))
    if (part.counted === 0 && shownHunks === 0 && first !== undefined) {
      // Nothing fits, and nothing is drawn yet: one character of the first line (its prefix) is better than a blank pane.
      part = { kept: [String.fromCodePoint(first.codePointAt(0) as number)], counted: 1, clipped: true }
    }
    if (shownHunks > 0 && part.counted < MIN_PARTIAL) break // the border of this hunk
    out.push(headerFor(hunk.header, part.kept), ...part.kept)
    lines += 1 + part.counted
    lineCut = part.clipped
    shownHunks++
    partial = true
    break
  }
  return {
    source: out.length === 0 ? '' : `${out.join('\n')}\n`,
    cut: cut || lineCut,
    partial,
    lineCut,
    shownLines: lines,
    totalLines,
    shownHunks,
    totalHunks: all.length,
  }
}

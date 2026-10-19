// Display width in terminal cells, as Claude Code 2.1.302 draws it, and the helpers that keep a cell on one line.
//
// `cellWidth` matches Bun.stringWidth(s, { ambiguousIsNarrow: true }), the call the renderer makes (tree-table section
// 3.5). The engine offers no measure API (E15), so the mod follows the same rule: a grapheme cluster that is an emoji
// takes 2 cells, any other cluster takes the sum of its code points, each 0 (controls, format and joiner characters,
// combining marks), 2 (East Asian Wide or Fullwidth, from get-east-asian-width 1.7.0) or 1 (the rest, ambiguous
// characters too). It uses only what the hooks environment has: Intl.Segmenter and Unicode property regexes (the /v
// flag needs target es2024).
//
// Two known misses, both of Hangul written as separate jamo (probed with Bun 1.4.3): a decomposed L+V syllable and a
// decomposed L+V+T syllable. Bun counts each as 2 cells. This rule gives 3 and 4, because it counts the vowel and the
// final jamo as one cell each. It over-counts, so a cell is cut early and never drawn too wide. Precomposed syllables
// (U+AC00 to U+D7A3, the usual NFC form) are right.
//
// Tests: tests/cell-width.test.ts compares the rule with Bun's own widths (tests/fixtures/width-vectors.ts).

// East Asian Wide and Fullwidth ranges, sorted: [first, last] code points. Six to a row, so the table stays short.
// biome-ignore format: a data table
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100,0x115f],[0x231a,0x231b],[0x2329,0x232a],[0x23e9,0x23ec],[0x23f0,0x23f0],[0x23f3,0x23f3],
  [0x25fd,0x25fe],[0x2614,0x2615],[0x2630,0x2637],[0x2648,0x2653],[0x267f,0x267f],[0x268a,0x268f],
  [0x2693,0x2693],[0x26a1,0x26a1],[0x26aa,0x26ab],[0x26bd,0x26be],[0x26c4,0x26c5],[0x26ce,0x26ce],
  [0x26d4,0x26d4],[0x26ea,0x26ea],[0x26f2,0x26f3],[0x26f5,0x26f5],[0x26fa,0x26fa],[0x26fd,0x26fd],
  [0x2705,0x2705],[0x270a,0x270b],[0x2728,0x2728],[0x274c,0x274c],[0x274e,0x274e],[0x2753,0x2755],
  [0x2757,0x2757],[0x2795,0x2797],[0x27b0,0x27b0],[0x27bf,0x27bf],[0x2b1b,0x2b1c],[0x2b50,0x2b50],
  [0x2b55,0x2b55],[0x2e80,0x2e99],[0x2e9b,0x2ef3],[0x2f00,0x2fd5],[0x2ff0,0x303e],[0x3041,0x3096],
  [0x3099,0x30ff],[0x3105,0x312f],[0x3131,0x318e],[0x3190,0x31e5],[0x31ef,0x321e],[0x3220,0x3247],
  [0x3250,0xa48c],[0xa490,0xa4c6],[0xa960,0xa97c],[0xac00,0xd7a3],[0xf900,0xfaff],[0xfe10,0xfe19],
  [0xfe30,0xfe52],[0xfe54,0xfe66],[0xfe68,0xfe6b],[0xff01,0xff60],[0xffe0,0xffe6],[0x16fe0,0x16fe4],
  [0x16ff0,0x16ff6],[0x17000,0x18cda],[0x18cff,0x18d20],[0x18d80,0x18df2],[0x18e00,0x19191],[0x191a0,0x191d2],
  [0x1aff0,0x1aff3],[0x1aff5,0x1affb],[0x1affd,0x1affe],[0x1b000,0x1b128],[0x1b132,0x1b132],[0x1b150,0x1b152],
  [0x1b155,0x1b155],[0x1b164,0x1b168],[0x1b170,0x1b2fb],[0x1d300,0x1d356],[0x1d360,0x1d376],[0x1f004,0x1f004],
  [0x1f0cf,0x1f0cf],[0x1f18e,0x1f18e],[0x1f191,0x1f19a],[0x1f1ae,0x1f1ae],[0x1f200,0x1f202],[0x1f210,0x1f23b],
  [0x1f240,0x1f248],[0x1f250,0x1f251],[0x1f260,0x1f265],[0x1f300,0x1f320],[0x1f32d,0x1f335],[0x1f337,0x1f37c],
  [0x1f37e,0x1f393],[0x1f3a0,0x1f3ca],[0x1f3cf,0x1f3d3],[0x1f3e0,0x1f3f0],[0x1f3f4,0x1f3f4],[0x1f3f8,0x1f43e],
  [0x1f440,0x1f440],[0x1f442,0x1f4fc],[0x1f4ff,0x1f53d],[0x1f54b,0x1f54e],[0x1f550,0x1f567],[0x1f57a,0x1f57a],
  [0x1f595,0x1f596],[0x1f5a4,0x1f5a4],[0x1f5fb,0x1f64f],[0x1f680,0x1f6c5],[0x1f6cc,0x1f6cc],[0x1f6d0,0x1f6d2],
  [0x1f6d5,0x1f6d9],[0x1f6dc,0x1f6df],[0x1f6eb,0x1f6ec],[0x1f6f4,0x1f6fc],[0x1f7da,0x1f7da],[0x1f7e0,0x1f7eb],
  [0x1f7f0,0x1f7f0],[0x1f90c,0x1f93a],[0x1f93c,0x1f945],[0x1f947,0x1f9ff],[0x1fa70,0x1fa7c],[0x1fa80,0x1fac6],
  [0x1fac8,0x1fac8],[0x1facc,0x1fadd],[0x1fadf,0x1faeb],[0x1faef,0x1fafa],[0x20000,0x2fffd],[0x30000,0x3fffd]
]

function isWide(cp: number): boolean {
  let lo = 0
  let hi = WIDE.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = WIDE[mid]!
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}

const segmenter = new Intl.Segmenter()
// Zero width, as Bun.stringWidth counts it: controls, format and joiner characters, combining marks, lone surrogates.
const ZERO =
  /[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Nonspacing_Mark}\p{Enclosing_Mark}\p{Spacing_Mark}\p{Surrogate}]/v
const RGI_EMOJI = /^\p{RGI_Emoji}$/v
const PICTOGRAPHIC = /\p{Extended_Pictographic}/gu
const KEYCAP = /^[\d#*]\u20E3$/

/** CSI, OSC (BEL or ST end), charset select and single-character escapes. The pattern of e2e/support/ansi.ts. */
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-Za-z]|[@-Z\\-_=>78])/g
/** The C0 and C1 control characters, tab and newline among them, and DEL. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Terminal cells a string takes in Claude Code 2.1.302: a grapheme cluster that is an emoji (RGI, keycap, ZWJ
 * sequence of two or more pictographs) takes 2; any other cluster takes the sum of its code points, each 0 (see
 * ZERO), 2 (East Asian Wide or Fullwidth) or 1. Ambiguous-width characters take 1.
 * Run `normaliseCell` first: this counts no tab, ANSI escape or newline.
 */
export function cellWidth(text: string): number {
  if (/^[\u0020-\u007E]*$/.test(text)) return text.length
  let width = 0
  for (const { segment } of segmenter.segment(text)) {
    if (
      RGI_EMOJI.test(segment) ||
      KEYCAP.test(segment) ||
      (segment.includes('\u200D') && (segment.match(PICTOGRAPHIC)?.length ?? 0) >= 2)
    ) {
      width += 2
      continue
    }
    for (const ch of segment) {
      if (!ZERO.test(ch)) width += isWide(ch.codePointAt(0)!) ? 2 : 1
    }
  }
  return width
}

/**
 * The text of a cell on one line: each ANSI escape, tab, newline and other control character becomes one space.
 * Titles come from outside tools and web pages, so any of them can hold these (Review Focus 1).
 */
export function normaliseCell(text: string): string {
  return text.replace(ANSI, ' ').replace(CONTROL, ' ')
}

/**
 * The text cut to at most `cells` cells. A cut text ends in `…`. It cuts by grapheme, never through a surrogate pair,
 * an emoji sequence or a wide character. Nothing fits in 0 cells or fewer: the result is empty.
 */
export function clipTo(text: string, cells: number): string {
  if (cells <= 0) return ''
  if (cellWidth(text) <= cells) return text
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(text)) {
    const width = cellWidth(segment)
    if (used + width > cells - 1) break
    out += segment
    used += width
  }
  return `${out}…`
}

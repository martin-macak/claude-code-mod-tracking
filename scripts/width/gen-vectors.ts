// Regenerates plugins/artifact-tracking/tests/fixtures/width-vectors.ts with Bun. Bun only: no test runs it.
//   npx -y bun@1.4.3 scripts/width/gen-vectors.ts > plugins/artifact-tracking/tests/fixtures/width-vectors.ts
// The list is the 37 vectors of the width spike plus the glyphs the pane draws. The width of each string is what
// Bun.stringWidth gives with `ambiguousIsNarrow: true`, the setting Claude Code uses. The Bun in Claude Code 2.1.302 is
// 1.4.4; 1.4.3 gives the same widths for these strings. A width that differs from the spike's is an error.
import { VECTORS as SPIKE } from '../../docs/knowledge-base/claude-code-mods/sources/spikes-2026-10-17/width-spike/tests/vectors.ts'

declare const Bun: { stringWidth(text: string, options?: { ambiguousIsNarrow?: boolean }): number }

/** The glyphs the pane draws: the expand glyphs, the selection marker, the clip mark, the ambiguous-width symbols. */
const GLYPHS = ['▸', '▾', '>', '…', '★▲▽', '✓✗●↳→·']

const width = (s: string): number => Bun.stringWidth(s, { ambiguousIsNarrow: true })

/** A string literal. Combining marks, format characters and other invisible ones are written as \u{...}. */
function literal(s: string): string {
  let out = ''
  for (const ch of s) {
    if (ch === "'" || ch === '\\') out += `\\${ch}`
    else if (ch !== ' ' && /[\p{C}\p{M}\p{Z}]/u.test(ch)) out += `\\u{${ch.codePointAt(0)?.toString(16)}}`
    else out += ch
  }
  return `'${out}'`
}

const lines: string[] = []
for (const [s, spike] of SPIKE) {
  const w = width(s)
  if (w !== spike) throw new Error(`${JSON.stringify(s)}: Bun gives ${w}, the spike wants ${spike}`)
  lines.push(`  [${literal(s)}, ${w}],`)
}
for (const s of GLYPHS) lines.push(`  [${literal(s)}, ${width(s)}],`)

console.log(`// Generated with \`npx -y bun@1.4.3 scripts/width/gen-vectors.ts\`. Do not edit by hand.
// Each width is \`Bun.stringWidth(s, { ambiguousIsNarrow: true })\`, as Claude Code 2.1.302 draws it (its Bun is 1.4.4).
// The first 37 are the vectors of the width spike (docs/knowledge-base/claude-code-mods/sources/spikes-2026-10-17/width-spike),
// the rest are the glyphs the pane draws. Invisible characters are written as \\u{...}.
export const VECTORS: ReadonlyArray<readonly [string, number]> = [
${lines.join('\n')}
]`)

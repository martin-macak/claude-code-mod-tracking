import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripAnsi } from '../support/ansi.ts'
import { readTimeline } from '../support/timeline.ts'
import { type Cast, parseCast, writeCast } from './cast.ts'
import { retime } from './retime.ts'

export const GIF_BUDGET_BYTES = 2_097_152
export const FAST_SECONDS = 1

export function aggArgs(cast: string, gif: string): string[] {
  return [
    '--theme',
    'dracula',
    '--font-family',
    'JetBrains Mono,Menlo,DejaVu Sans Mono',
    '--font-size',
    '14',
    '--fps-cap',
    '15',
    '--idle-time-limit',
    '5',
    '--last-frame-duration',
    '4',
    cast,
    gif,
  ]
}

export function gifsicleArgs(gif: string): string[] {
  return ['--batch', '-O3', '--lossy=60', '--colors', '128', gif]
}

export function budgetError(bytes: number, budget = GIF_BUDGET_BYTES): string | undefined {
  if (bytes <= budget) return undefined
  const mb = (n: number) => (n / 1024 / 1024).toFixed(2)
  return `demo: the GIF is ${mb(bytes)} MB, over the ${mb(budget)} MB budget. Cut a beat, lower --fps-cap or raise --lossy.`
}

// Account data that Claude Code 2.1.296 prints: the plan name in the banner and usage notices.
export const REDACTIONS: readonly RegExp[] = [
  / · Claude (Max|Pro|Team|Enterprise)/g,
  // To the end of the run of text, so a notice cut short to a narrow column goes too.
  /You've used \d+%[^\u001b\r\n]*/g,
  // The reset time names the viewer's time zone. It can wrap onto its own line.
  /resets \d{1,2}(?::\d{2})?\s?(?:am|pm)? \([^)\r\n\u001b]*\)/g,
]

// Blanks each match with spaces of the same width, so the screen layout stays the same. It matches
// on all output joined, because asciinema can split a line over two events.
export function redact(cast: Cast, patterns: readonly RegExp[] = REDACTIONS): Cast {
  const joined = cast.events.map(([, code, data]) => (code === 'o' ? data : '')).join('')
  const blanked = new Uint8Array(joined.length)
  for (const re of patterns) {
    for (const m of joined.matchAll(re)) blanked.fill(1, m.index, m.index + m[0].length)
  }
  let offset = 0
  return {
    header: cast.header,
    events: cast.events.map(([t, code, data]) => {
      if (code !== 'o') return [t, code, data]
      const start = offset
      offset += data.length
      // UTF-16 units, so the index matches the offset in joined.
      const out = data
        .split('')
        .map((ch, i) => (blanked[start + i] ? ' ' : ch))
        .join('')
      return [t, code, out]
    }),
  }
}

// Fail closed: text that must never reach the GIF, checked after redaction.
export const LEAKS: readonly RegExp[] = [
  /\/(?:Users|home)\/[^/\s]+/,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /Claude (?:Max|Pro|Team|Enterprise)/,
  /used \d+% of/,
  /resets \d/,
  /Organization/,
]

// The first leak in the visible output text, or undefined. Output is joined and stripped of
// escape codes first, so a split or styled leak is found too.
export function leakError(cast: Cast, leaks: readonly RegExp[] = LEAKS): string | undefined {
  const text = stripAnsi(cast.events.map(([, code, data]) => (code === 'o' ? data : '')).join(''))
  for (const re of leaks) {
    const hit = text.match(re)
    if (hit) return `demo: the recording shows "${hit[0]}" (${re}). Add a pattern to REDACTIONS in render/render.ts.`
  }
  return undefined
}

// Claude Code puts a no-break space after the prompt mark. agg draws it as a stray glyph.
export function normalizeGlyphs(cast: Cast): Cast {
  return {
    header: cast.header,
    events: cast.events.map(([t, code, data]) => [t, code, code === 'o' ? data.replaceAll('\u00a0', ' ') : data]),
  }
}

export function render(scenarioDir: string, gif: string): number {
  const cast = parseCast(readFileSync(join(scenarioDir, 'session.cast'), 'utf8'))
  const timeline = readTimeline(join(scenarioDir, 'timeline.ndjson'))
  const retimed = join(scenarioDir, 'session.retimed.cast')
  const clean = redact(normalizeGlyphs(retime(cast, timeline, { fastSeconds: FAST_SECONDS })))
  const leak = leakError(clean)
  if (leak !== undefined) throw new Error(leak)
  writeFileSync(retimed, writeCast(clean))
  execFileSync('agg', aggArgs(retimed, gif), { stdio: 'inherit' })
  execFileSync('gifsicle', gifsicleArgs(gif), { stdio: 'inherit' })
  return statSync(gif).size
}

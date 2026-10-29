// The preview of a file row (issue #57, L2): the view mode. The provider reads the file when the person asks, with `head -c` through
// the tool port (a CLI call, as the issue says: no 4 MiB refusal of a file read, and one path for any size), and gives core blocks to
// draw: a notice for what cannot be shown (a secret, a folder, an image, a binary file, a file that is gone, a cut), then the
// source, drawn by `Code` with the language of the path and a line gutter. Nothing is stored: the content goes back to the pane
// and sits in its module memory. The mode `diff` is the next layer, so a row has `view` alone. The provider never sanitizes: core
// draws every string through one rule (`ux/text/sanitize.ts`), so the caps below count the characters as they came.
// Design study R9, R14, R17 (view part), G3, G9: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787

import type { Json } from '../../core/interfaces/items'
import type {
  PreviewBlock,
  PreviewContent,
  PreviewLimits,
  PreviewMode,
  PreviewModeId,
  PreviewSpec,
} from '../../core/interfaces/preview'
import type { TrackerContext } from '../../core/interfaces/tracker'
import type { ViewContext } from '../../core/interfaces/view'
import { relativeToRoot } from '../../core/lib/paths'
import { firstLine, message } from '../../core/lib/text'
import { type FileConfig, HEAD_BYTES } from './config'
import { fileTypeOf } from './file-type'
import { fileKind } from './kind'
import { isSecretPath, needsHome } from './secret'
import type { FileRecord } from './types'

/** A file with a NUL in its first 8 KB is binary. */
const BINARY_SCAN = 8192
/** `head` of 256 KiB takes milliseconds. A file on a hung mount must not hold the pane. */
const HEAD_TIMEOUT_MS = 5000

const VIEW: readonly PreviewMode[] = [{ id: 'view', enabled: true }]

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/**
 * `12 B`, `2.0 KB`, `293 KB`, `1.5 MB`: three digits at most, one decimal below 100. The unit steps up at the rounded value, so
 * 1,048,575 bytes read `1.0 MB` and not `1024 KB`, and 102,350 bytes read `100 KB` and not `100.0 KB`.
 */
export function sizeText(bytes: number): string {
  let n = bytes
  let unit = 0
  while (n >= 1023.5 && unit < UNITS.length - 1) {
    n /= 1024
    unit++
  }
  if (unit === 0) return `${bytes} B`
  return `${n >= 99.95 ? Math.round(n) : n.toFixed(1)} ${UNITS[unit]}`
}

const notice = (text: string, tone: 'info' | 'warning' = 'info'): PreviewBlock => ({ kind: 'notice', text, tone })

/** One line of a CLI's stderr, for a notice: the first line, or `exit N` when it said nothing. */
const failureOf = (stderr: string, exitCode: number): string => firstLine(stderr) || `exit ${exitCode}`

/** The MIME type that `file` answered for the row, or undefined when it did not ask, or answered `unknown`. */
const mimeOf = (rec: FileRecord): string | undefined =>
  rec.mime !== undefined && rec.mime !== 'unknown' ? rec.mime : undefined

/** The type word that a notice about a binary file gives: the MIME type when `file` answered one, else the type of the map. */
const kindOf = (rec: FileRecord): string => mimeOf(rec) ?? fileTypeOf(rec)

/**
 * The lines to draw, cut at the caps. A cap of lines and a cap of characters cut at a whole line. A first line over the character cap
 * is cut at the cap, so a minified file still shows something, and a surrogate pair is never cut in two. `whole`: nothing was cut.
 */
function cutLines(lines: readonly string[], maxLines: number, maxChars: number): { shown: string[]; partial: boolean } {
  const shown: string[] = []
  let used = 0
  for (const line of lines.slice(0, maxLines)) {
    if (used + line.length + 1 > maxChars) {
      if (shown.length > 0) break
      let head = line.slice(0, maxChars)
      const last = head.charCodeAt(head.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1) // the first half of a pair: it goes whole, or not at all
      return { shown: [head], partial: true }
    }
    shown.push(line)
    used += line.length + 1
  }
  return { shown, partial: false }
}

/** The blocks of a text that `head` read: the notice of a cut first, then the code. */
function viewOf(
  rec: FileRecord,
  text: string,
  size: number,
  cut: boolean,
  caps: { maxLines: number; maxChars: number },
) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop() // the text ended with a newline: no line follows it
  // Read less than the file: the last line may be unfinished, so it goes (one line alone stays: it is all there is). The file still
  // has that line, so `dropped` keeps the fact for the notice of a first line that is cut: lines come after it, though none is left to draw.
  const dropped = cut && !text.endsWith('\n') && lines.length > 1
  if (dropped) lines.pop()
  const { shown, partial } = cutLines(lines, caps.maxLines, caps.maxChars)
  const whole = !cut && !partial && shown.length === lines.length
  const source = whole ? text : `${shown.join('\n')}${partial ? '' : '\n'}`
  const count = partial ? 1 : shown.length
  const blocks: PreviewBlock[] = []
  if (partial) {
    // The first line is longer than the cap and is all that shows. Say what else is left out: the lines after it, and the end of a file
    // that `head` did not read to its end.
    blocks.push(
      notice(
        lines.length > 1 || dropped
          ? `Truncated: the first line is cut at ${caps.maxChars} characters, and the lines after it are not shown.`
          : `Truncated: a line is cut at ${caps.maxChars} characters${cut ? `, in a file of ${sizeText(size)}` : ''}.`,
        'warning',
      ),
    )
  } else if (cut) blocks.push(notice(`Truncated: the first ${count} lines of a file of ${sizeText(size)}.`, 'warning'))
  else if (!whole) blocks.push(notice(`Truncated: the first ${count} of ${lines.length} lines.`, 'warning'))
  blocks.push({ kind: 'code', source, path: rec.label, startLine: 1 })
  return { blocks, count }
}

/** The modes of a row of a tracked file: the view. A row that no file record backs has no preview. */
function modes(ctx: ViewContext<FileConfig, Json>, rowId: string): readonly PreviewMode[] | undefined {
  return ctx.items.some(item => item.key === rowId && item.category === 'file') ? VIEW : undefined
}

/** The content of one mode of a file row. Rejects only for a failure it did not expect: core turns that into a notice. */
async function load(
  ctx: TrackerContext<FileConfig, Json>,
  rowId: string,
  mode: PreviewModeId,
  limits: PreviewLimits,
): Promise<PreviewContent> {
  const rec = (await ctx.items.list()).flatMap(item => fileKind.decode(item) ?? []).find(r => r.key === rowId)
  if (rec === undefined) return { title: 'Preview', blocks: [notice('This file is not tracked any more.')] }
  const root = ctx.session.root()
  const title = root === undefined ? rec.label : relativeToRoot(rec.label, root)
  const type = fileTypeOf(rec)
  const done = (blocks: PreviewBlock[], ...subtitle: string[]): PreviewContent => ({
    title,
    subtitle: [type, mode, ...subtitle].join(' · '),
    blocks,
  })
  // The secret rule comes first, before the mode and before any read of content: a mode that shows more than the view (the diff of the
  // next layer) must meet it too. The path as spelled and as the file landed decide, then the real path of a link as it is now.
  const config = ctx.config.slice()
  // The home folder only matters for a glob that starts with `~/`. A refused read must not stop the preview of an ordinary file, but it
  // must stop every preview when a glob of the person needs it: the rule cannot say what that glob hides.
  const home = await ctx.env.get('HOME').catch(() => undefined)
  if (needsHome(config.secretPaths) && !home) {
    return done([
      notice(
        'A secretPaths glob starts with ~/ and the home folder is not known, so the rule cannot tell what it hides. The preview never reads the file.',
        'warning',
      ),
    ])
  }
  const secret = { extra: config.secretPaths, home }
  const secretNotice = notice(
    'A secret file: the path matches the secret rule (trackers.file.secretPaths adds more). The preview never reads it.',
    'warning',
  )
  if (isSecretPath(rec.label, secret) || isSecretPath(rec.url, secret)) return done([secretNotice])
  // A stat reads no content. A path that became a link since the row was made may lead to a key: its real path is checked as well.
  const stat = await ctx.fs.stat(rec.url, { resolve: true })
  if (stat?.realPath !== undefined && isSecretPath(stat.realPath, secret)) return done([secretNotice])
  if (mode !== 'view') return done([notice('This mode is not available for a file yet.')])
  if (stat === null) {
    return done([
      notice(
        rec.deleted === true
          ? 'Deleted by a Bash command: the file is gone.'
          : 'The file is not there, or it could not be read: it was moved or deleted, or access was refused.',
      ),
    ])
  }
  if (stat.kind === 'dir') return done([notice('A folder, not a file.')])
  if (stat.kind === 'other') return done([notice('Not a regular file: a device, a socket or a pipe.')])
  if (type === 'image') {
    const mime = mimeOf(rec)
    return done([
      notice(`Image${mime === undefined ? '' : ` (${mime})`}, ${sizeText(stat.size)}. The preview shows no pixels.`),
    ])
  }
  if (stat.size === 0) return done([notice('Empty file.')])
  let out: Awaited<ReturnType<TrackerContext['tools']['run']>>
  try {
    out = await ctx.tools.run('head', ['head', '-c', String(HEAD_BYTES), '--', rec.url], { timeoutMs: HEAD_TIMEOUT_MS })
  } catch (e) {
    return done([notice(`Could not read the file: ${message(e)}`, 'warning')])
  }
  if (out.exitCode !== 0) {
    return done([notice(`Could not read the file: ${failureOf(out.stderr, out.exitCode)}`, 'warning')])
  }
  if (out.stdout.slice(0, BINARY_SCAN).includes('\u0000')) {
    return done([notice(`Binary file, ${kindOf(rec)}, ${sizeText(stat.size)}. The preview shows text only.`)])
  }
  const caps = {
    maxLines: Math.min(config.preview.maxLines, limits.maxLines),
    maxChars: Math.min(config.preview.maxChars, limits.maxChars),
  }
  const cut = stat.size > HEAD_BYTES || out.isStdoutTruncated === true
  const view = viewOf(rec, out.stdout, stat.size, cut, caps)
  return done(view.blocks, `${view.count} ${view.count === 1 ? 'line' : 'lines'}`)
}

/** The file tracker's preview: the view of a row, and the modes it has. */
export const filePreview: PreviewSpec<FileConfig, Json> = { modes, load }

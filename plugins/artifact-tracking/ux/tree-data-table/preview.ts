// The preview body (issue #57, L2): what the pane draws in place of the table while a preview shows. A header (the title in bold,
// a dim second part), the key line (`↩ back`, `v`, `d`, `r` and the hint `Esc back`), the other keys as dim Buttons (issue #277), then
// the notices, then the blocks. The order is the design: keys first, notices next, content last, so the cut of the budget guard and
// the scroll of the engine never take a key or a notice. The detail view of a row (issue #277) is this body with the block `fields`. The engine scrolls a tall body (the header and the key line scroll away, their hotkeys still fire). Every string is made
// safe first: one control character in a `Code` source makes the engine refuse the whole tree. Pure.
// Design study of issue #57, comment 6414682787 (R10, G4, G9, G10).
import type { RenderElement } from 'claude-code'
import type { PreviewBlock, PreviewField } from '../../core/interfaces/preview'
import type { FooterKey } from '../../core/interfaces/view'
import { cellWidth, clipMiddle, clipTo, normaliseCell } from '../text/cell-width'
import { sanitize } from '../text/sanitize'
import { COLOR } from '../theme'
import { BUDGET, type Cost, guard } from './budget'
import { box, button, code, markdown, type TableElements, text } from './el'
import { footerBox, ITEM_GAP, keyButton } from './footer'
import { DEFAULT_BODY_COLUMNS, type TableActions } from './shape'

/**
 * One rule for every string the preview draws (G9): a control character shows as U+FFFD (`sanitize`), then a line of words keeps to
 * one line (`normaliseCell`: a tab or a newline becomes a space, and the cell width counts no control character). `Code` and `Markdown`
 * take `sanitize` alone, so a source keeps its tabs and its lines.
 */
const safe = (words: string): string => normaliseCell(sanitize(words))

/** What the body says while the content is not in memory yet (a hot reload loses it): a load starts and draws the pane again. */
export const LOADING = 'Loading…'
/** What the body says when the blocks do not fit the budget. The notices stay above it. */
export const PREVIEW_TOO_LARGE = 'The preview is too large to draw.'
/** How to leave: the first Esc goes back to the list, the second closes the pane. */
export const BACK_HINT = 'Esc back'
/** The cells that a title keeps at least, before the second part of the header gives way. */
const MIN_TITLE = 10
/** The words of the first Button of the key line. It has no hotkey, so Enter on it (the ring is there when the view opens) goes back. */
export const BACK_LABEL = '↩ back'
/** The cells of the label column of a `fields` block, at most: a longer label is cut, and the text keeps the room that is left. */
const MAX_LABEL = 14

export interface PreviewView {
  /** The first part of the header: a path, a name. Cut in the middle when the header is too long. */
  readonly title: string
  /** The dim second part: the type, the mode and the size. Whole as long as the title keeps `MIN_TITLE` cells. */
  readonly subtitle?: string | undefined
  /** The Buttons of the key line: the modes of the row, then `r: reload` (`previewKeys`). */
  readonly keys: readonly FooterKey[]
  /** The Button key of `↩ back`, drawn first on the key line. Absent: no such Button (the file modes: only the detail view draws it). */
  readonly back?: string | undefined
  /**
   * The keys that are no key of the view, as dim Buttons on a line of their own (issue #277, the rule of issue #200): the view has no
   * footer and no view line, so a letter with no Button would leave the pane for the prompt. A press only gives the pane the keys.
   * Every mode draws them since issue #300 (a file mode too).
   */
  readonly dim?: readonly FooterKey[] | undefined
  /** The blocks, or `undefined` while they load. */
  readonly blocks: readonly PreviewBlock[] | undefined
  /** The cells of a body row. Absent: the table's default. */
  readonly columns?: number | undefined
  /** Default `BUDGET`. Tests pass a small one. */
  readonly budget?: Cost
}

/** The header: the title in bold, then the subtitle dim. It takes one row: the title gives way to the subtitle, then the subtitle to the title. */
function headerBox(el: TableElements, view: PreviewView, columns: number): RenderElement {
  const title = safe(view.title)
  const sub = view.subtitle === undefined ? '' : ` · ${safe(view.subtitle)}`
  const subWidth = cellWidth(sub)
  if (cellWidth(title) + subWidth <= columns) return rowOf(el, title, sub)
  if (sub !== '' && columns - subWidth >= MIN_TITLE) return rowOf(el, clipMiddle(title, columns - subWidth), sub)
  return rowOf(el, clipMiddle(title, columns), '')
}

const rowOf = (el: TableElements, title: string, sub: string): RenderElement =>
  box(el, {}, text(el, { weight: 'bold' }, title), ...(sub === '' ? [] : [text(el, { dimColor: true }, sub)]))

/** One notice: a warning in its color, any other dim. It wraps, so a long reason is read whole. */
function noticeText(el: TableElements, block: Extract<PreviewBlock, { kind: 'notice' }>): RenderElement {
  const tone = block.tone === 'warning' ? { color: COLOR.warning } : { dimColor: true }
  return text(el, { wrap: 'wrap', ...tone }, safe(block.text))
}

/**
 * The rows of a `fields` block (issue #277): a label column, as wide as the longest label up to `MAX_LABEL` cells, and beside it a text
 * that wraps. The label is dim. The text is made safe but keeps its newlines (a plan has lines), and a tab becomes two spaces, so the
 * engine wraps it by its own rule. One Box for each field, in one column Box: the labels stand under each other.
 */
function fieldsBox(el: TableElements, fields: readonly PreviewField[]): RenderElement {
  const labels = fields.map(f => clipTo(safe(f.label), MAX_LABEL))
  const width = Math.max(1, ...labels.map(cellWidth))
  return box(
    el,
    { flexDirection: 'column' },
    ...fields.map((f, i) => {
      const label = labels[i] ?? ''
      return box(
        el,
        { columnGap: 1 },
        box(el, { width, flexShrink: 0 }, ...(label === '' ? [] : [text(el, { dimColor: true }, label)])),
        text(el, { wrap: 'wrap' }, sanitize(f.text).replaceAll('\t', '  ')),
      )
    }),
  )
}

/** The Button `↩ back`: the first of the key line. It has no hotkey (Esc leaves the view too), so it takes no letter of the keys. */
const backButton = (el: TableElements, key: string, actions: TableActions): RenderElement =>
  button(el, { key, plain: true, label: BACK_LABEL, onPress: () => actions.back() })

/** The dim keys: one line of Buttons that wraps like the footer. A press does no work and only gives the pane the keys. */
const dimBox = (el: TableElements, keys: readonly FooterKey[], actions: TableActions): RenderElement =>
  box(el, { columnGap: ITEM_GAP, flexWrap: 'wrap' }, ...keys.map(k => keyButton(el, { ...k, enabled: false }, actions)))

/** The element of one block that is no notice. A prop is set only when the block has it: the engine refuses an odd prop. */
function contentOf(el: TableElements, block: Exclude<PreviewBlock, { kind: 'notice' }>): RenderElement {
  switch (block.kind) {
    case 'code':
      return code(el, {
        source: sanitize(block.source),
        ...(block.path === undefined ? {} : { path: safe(block.path) }),
        ...(block.language === undefined ? {} : { language: safe(block.language) }),
        ...(block.startLine === undefined ? {} : { startLine: block.startLine }),
        wrap: 'truncate-end',
      })
    case 'diff':
      return code(el, {
        source: sanitize(block.source),
        format: 'diff',
        ...(block.path === undefined ? {} : { path: safe(block.path) }),
        wrap: 'truncate-end',
      })
    case 'markdown':
      return markdown(el, { text: sanitize(block.text) })
    case 'fields':
      return fieldsBox(el, block.fields)
    default:
      return block satisfies never
  }
}

/**
 * The preview body. The budget guard reserves the header and the key line first, as it reserves the footer of the table, then
 * tries the notices and the content, and falls back to the notices and one line. A source over the engine's 100,000 characters
 * would drop the Buttons after it, so the guard counts `Code.source` and `Markdown.text` (`measure`).
 */
export function renderPreview(el: TableElements, view: PreviewView, actions: TableActions): RenderElement {
  const columns = view.columns ?? DEFAULT_BODY_COLUMNS
  const header = headerBox(el, view, columns)
  // The key line is the footer row of the preview. A mode that is off draws dim, but its press still goes to the pane: the pane says
  // why in a toast (`PreviewMode.reason`), where a dim key of the footer only asks for the keys.
  const lead = view.back === undefined ? [] : [backButton(el, view.back, actions)]
  const keys = footerBox(el, view.keys, actions, false, { close: BACK_HINT, pressOff: true, lead })
  const dim = view.dim === undefined || view.dim.length === 0 ? [] : [dimBox(el, view.dim, actions)]
  const blocks = view.blocks ?? []
  const notices = blocks.flatMap(b => (b.kind === 'notice' ? [noticeText(el, b)] : []))
  const content = blocks.flatMap(b => (b.kind === 'notice' ? [] : [contentOf(el, b)]))
  const body =
    view.blocks === undefined
      ? [text(el, { dimColor: true }, LOADING)]
      : guard(
          [header, keys, ...dim],
          [() => [...notices, ...content]],
          () => [...notices, text(el, { dimColor: true }, PREVIEW_TOO_LARGE)],
          view.budget ?? BUDGET,
        ).body
  return box(el, { flexDirection: 'column' }, header, keys, ...dim, ...body)
}

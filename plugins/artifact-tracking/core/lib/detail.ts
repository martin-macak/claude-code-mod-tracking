// The default model of the detail view (issue #277, L2 of #275). Core builds the fields of every row from the `TreeRow` alone, with no
// tracker code and no load: the cells whole, the badges, the links, the priority, the reasons, the turns, the first sighting, the kind,
// the source and the count of the children, then the `detail()` lines of the row (Questions). A field is left out when the row lacks
// what it shows. The source is always there, so a detail is never empty. The text is plain: the pane draws it through the `sanitize`
// rule and the budget guard of the preview (`ux/tree-data-table/preview.ts`). Pure.
// Design of issue #275, "The detail view" (the default model).

import type { PreviewContent, PreviewField } from '../interfaces/preview'
import { type CellId, canOpen, type DetailLine, type TreeRow } from '../interfaces/view'
import { PREVIEW_LIMITS } from './preview'
import { ago } from './text'

/** One line of the view: a label column and the text. A text may hold newlines (a plan); it wraps in the pane. */
export type DetailField = PreviewField

/** What the model needs besides the row: the title of the group the row sits in, and the time the age is read against. */
export interface DetailContext {
  /** The title of the group of the row: `Pull requests`. The source field adds the tracker id: `Pull requests · <tracker id>`. */
  readonly group: string
  /** Epoch ms. */
  readonly now: number
}

/** The cells the model shows, in order, and their labels. The control cell is the level marker: `Priority` says it in words. */
const CELLS: readonly (readonly [CellId, string])[] = [
  ['name', 'Name'],
  ['description', 'Description'],
  ['type', 'Type'],
  ['status', 'Status'],
]

const DAY = 86_400_000

/** A cell or a badge is one line: whitespace runs become one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const two = (n: number): string => String(n).padStart(2, '0')

/** `10:42 (2h ago)`; a day old or more it names the date too. Local time. Under a second, or in the future, it reads `just now`. */
function firstSeen(at: number, now: number): string {
  const d = new Date(at)
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`
  const age = ago(Math.max(0, now - at))
  const date = now - at >= DAY ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` : ''
  return `${date}${clock} (${age === 'now' ? 'just now' : `${age} ago`})`
}

/** The label of a `detail()` line: its first letter capital. An empty one stays empty. */
const labelOf = (line: DetailLine): string =>
  line.label === undefined ? '' : oneLine(line.label).replace(/^./u, c => c.toUpperCase())

/** The priority in words: who set it. A row with no level has none (the rows of the slot trackers). */
function priorityOf(row: TreeRow): string | undefined {
  const level = row.facets?.level
  if (level?.level === undefined) return undefined
  return `${level.level} (${level.auto === true ? 'rule' : 'your mark'})`
}

/**
 * The fields of the detail view of `row`. Calls the `detail()` of the row once. The order is the design: what the row is, where it
 * stands, why it is tracked, where it came from, then what the tracker adds.
 */
export function detailFields(row: TreeRow, ctx: DetailContext): readonly DetailField[] {
  const fields: DetailField[] = []
  const add = (label: string, text: string | undefined): void => {
    if (text !== undefined && text !== '') fields.push({ label, text })
  }
  for (const [id, label] of CELLS) add(label, oneLine(row.cells[id]?.text ?? ''))
  add(
    'Badges',
    (row.extras ?? [])
      .map(b => oneLine(b.text))
      .filter(t => t !== '')
      .join(' · '),
  )
  // Every address of the row once, the badges' too: the table shows a link as a coloured cell, and no cell carries the address whole.
  const hrefs = [...Object.values(row.cells), ...(row.extras ?? [])].map(c => c?.href?.trim() ?? '')
  for (const href of new Set(hrefs)) add('Link', href)
  add('Priority', priorityOf(row))
  add('Reasons', row.reasons?.all.join(', '))
  add('Turns', row.turns === undefined ? undefined : `first ${row.turns.first} · last ${row.turns.last}`)
  const seen = row.facets?.firstSeen
  add('First seen', seen === undefined ? undefined : firstSeen(seen, ctx.now))
  add('Kind', row.facets?.kind)
  add('Source', `${oneLine(ctx.group)} · ${row.owner}`)
  const kids = row.children?.length ?? 0
  add('Children', canOpen(row) ? String(kids) : undefined)
  for (const line of row.detail?.() ?? []) {
    if (line.cell.text.trim() !== '') fields.push({ label: labelOf(line), text: line.cell.text })
  }
  return fields
}

/** The fields that fit, and whether any was cut. */
export interface FittedFields {
  readonly fields: readonly DetailField[]
  readonly cut: boolean
}

/** The mark that ends a text the model cut. */
const ELLIPSIS = '…'

/** The first `room` UTF-16 units of `text`, less one when the cut would leave the first half of an astral character alone. */
function cutAt(text: string, room: number): string {
  const high = text.charCodeAt(room - 1)
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? room - 1 : room)
}

/**
 * The most fields the view draws. A field costs up to 6 counted values in the tree (`fieldsBox`: a row Box, the label Box, the label
 * Text and its string, the text Text and its string), and the guard of the pane keeps 15,000 values for the whole drawing
 * (`ux/tree-data-table/budget.ts`). The Questions tracker makes one `detail()` line for each line of a plan, so a plan of many short
 * lines is under the character limit and over the value budget: 2,000 fields cost 12,000 values and leave room for the header and the keys.
 */
export const DETAIL_MAX_FIELDS = 2_000

/**
 * The fields held to `maxChars` characters and to `DETAIL_MAX_FIELDS` fields, labels and texts together: the engine draws 100,000 characters of a tree in all, and the
 * guard of the pane keeps 80,000 (`core/lib/preview.ts`, `PREVIEW_LIMITS`), so a plan of 100,000 characters is cut here and the
 * person reads its head, with the keys, instead of a notice that says the view is too large. The first field that does not fit is cut
 * at the characters that are left, and the fields after it are dropped. The `detail()` lines of the tracker come last in the model, so
 * they are what goes first. A field whose label alone does not fit is dropped.
 */
export function fitFields(
  fields: readonly DetailField[],
  maxChars: number,
  maxFields: number = DETAIL_MAX_FIELDS,
): FittedFields {
  const kept: DetailField[] = []
  let left = maxChars
  for (const raw of fields) {
    if (kept.length >= maxFields) return { fields: kept, cut: true }
    // A tab is drawn as two spaces (`fieldsBox`), so it costs two characters here too.
    const field = raw.text.includes('\t') ? { label: raw.label, text: raw.text.replaceAll('\t', '  ') } : raw
    const cost = field.label.length + field.text.length
    if (cost <= left) {
      kept.push(field)
      left -= cost
      continue
    }
    const room = left - field.label.length - ELLIPSIS.length
    if (room > 0) kept.push({ label: field.label, text: `${cutAt(field.text, room)}${ELLIPSIS}` })
    return { fields: kept, cut: true }
  }
  return { fields: kept, cut: false }
}

/** What the view says before its fields when the model cut the end of a very long text (a plan of 100,000 characters). */
export const DETAIL_NOTICE_CUT = 'The row has more text than the view can draw. The end is cut.'

/** What the view says when its row left the pane while the view was open (a TTL, `/track clear`): `↩ back` stays. */
export const GONE: PreviewContent = {
  title: 'Detail',
  blocks: [{ kind: 'notice', text: 'This row is gone', tone: 'info' }],
}

/**
 * The content of the detail view of `row`: the row on the first line (its name, else its description, else its id), the group, the
 * status and the mode on the dim part of it, and the fields in one block. A cut model says so in a notice, which the body draws before
 * the fields. The fields are held to the characters that the preview can draw (`PREVIEW_LIMITS`). Built at each drawing from the row
 * itself: it is never loaded, stored or kept in the cache.
 */
export function detailContent(row: TreeRow, ctx: DetailContext): PreviewContent {
  const { fields, cut } = fitFields(detailFields(row, ctx), PREVIEW_LIMITS.maxChars)
  const name = oneLine(row.cells.name?.text ?? '') || oneLine(row.cells.description?.text ?? '') || row.id
  const status = oneLine(row.cells.status?.text ?? '')
  return {
    title: name,
    subtitle: [oneLine(ctx.group), status, 'detail'].filter(part => part !== '').join(' · '),
    blocks: [
      ...(cut ? [{ kind: 'notice' as const, text: DETAIL_NOTICE_CUT, tone: 'info' as const }] : []),
      { kind: 'fields', fields },
    ],
  }
}

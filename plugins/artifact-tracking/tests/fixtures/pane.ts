// Kit helpers for the pane (plan L6, Task 13): mount it, read the rows and the header rows of the drawn tree, find the
// handle of a row by its text and move the ring onto it. They read the plain-data tree `ui.drawn()` returns. The engine
// leaves out an empty `props` and an empty `children`, so every read below defaults both.
import type { Engine } from 'claude-code/testing'
import { PANE, sleep } from './world'

type Raw = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

export type PaneUi = {
  drawn(): Promise<unknown>
  find(q: unknown): Promise<unknown>
  findAll(q: unknown): Promise<{ key?: string; text?: string; props: Record<string, unknown> }[]>
  press(q: { key: string }): Promise<void>
  redraw(): Promise<void>
  unmount(): Promise<void>
}

export type RowView = {
  handle: string
  text: string
  selected: boolean
  background: unknown
  autoFocus: boolean
  glyph: string
}

const isRaw = (x: unknown): x is Raw => typeof x === 'object' && x !== null
const kids = (n: unknown): unknown[] => (isRaw(n) ? (n.children ?? []) : [])
const propsOf = (n: unknown): Record<string, unknown> => (isRaw(n) ? (n.props ?? {}) : {})

/** Every node of `type` at or below `tree`, depth first. */
function all(tree: unknown, type: string): Raw[] {
  if (!isRaw(tree)) return []
  return [...(tree.type === type ? [tree] : []), ...kids(tree).flatMap(c => all(c, type))]
}

/** The strings at or below `node`, in order. A Button holds its label in a prop, so the glyph is not among them. */
function leaves(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  return kids(node).flatMap(leaves)
}

/**
 * The pane as the kit draws it: the terminal surface at 96 columns, docked, with 28 body rows, holding the keys, unless
 * `o` says otherwise. `bodyRows` and `placement` are what the engine gives a short inline pane.
 */
export function mountPane(
  $: Engine,
  o: {
    surface?: 'terminal' | 'desktop'
    bodyColumns?: number
    bodyRows?: number
    placement?: 'dock' | 'inline'
    /** Whether the pane has the keys (`Pane.isFocused`). Default: it has them, as after `/track` opens it with focus. */
    isFocused?: boolean
  } = {},
): Promise<PaneUi> {
  const props = {
    ...PANE.props,
    isFocused: o.isFocused ?? true,
    ...(o.bodyColumns === undefined ? {} : { bodyColumns: o.bodyColumns }),
    ...(o.bodyRows === undefined ? {} : { scroll: { ...PANE.props.scroll, bodyRows: o.bodyRows } }),
    ...(o.placement === undefined ? {} : { placement: o.placement }),
  }
  return $.ui.mount({ ...PANE, props, surface: o.surface ?? 'terminal' } as never) as unknown as Promise<PaneUi>
}

/** A row Box starts with the gutter Text: `>` on the selected row, else a space. */
const startsWithGutter = (box: Raw): boolean => {
  const first = kids(box)[0]
  return isRaw(first) && first.type === 'Text' && [' ', '>'].includes(String(kids(first)[0]))
}

/** The nearest Box above each node, with the Box path from the root. Row Boxes hold their handle Button inside a cell. */
function rowBoxOf(tree: unknown, handle: Raw): Raw | undefined {
  const walk = (node: unknown, path: Raw[]): Raw[] | undefined => {
    if (node === handle) return path
    for (const c of kids(node)) {
      const hit = walk(c, isRaw(node) && node.type === 'Box' ? [...path, node] : path)
      if (hit) return hit
    }
    return undefined
  }
  return (walk(tree, []) ?? []).reverse().find(startsWithGutter)
}

/** One entry per Button keyed `r<n>`: the row Box around it (the nearest Box whose first child is the gutter Text). */
export function rowsOf(tree: unknown): RowView[] {
  return all(tree, 'Button')
    .filter(b => /^r\d+$/.test(String(propsOf(b).key)))
    .flatMap(b => {
      const row = rowBoxOf(tree, b)
      if (row === undefined) return []
      const gutter = String(kids(kids(row)[0])[0])
      return [
        {
          handle: String(propsOf(b).key),
          text: leaves(row).join(' '),
          selected: gutter === '>',
          background: propsOf(row).backgroundColor,
          autoFocus: propsOf(b).autoFocus === true,
          glyph: String(propsOf(b).label),
        },
      ]
    })
}

/** Per header row (gutter Text, bold column headers, no Button): the texts of its bold Texts. */
export function headersOf(tree: unknown): string[][] {
  return all(tree, 'Box')
    .filter(b => startsWithGutter(b) && all(b, 'Button').length === 0)
    .map(b =>
      all(b, 'Text')
        .filter(t => propsOf(t).weight === 'bold')
        .map(t => leaves(t).join('')),
    )
    .filter(texts => texts.length > 0)
}

/** The handle of the first row whose text includes `text`, as last drawn. */
export async function handleFor(ui: PaneUi, text: string): Promise<string> {
  const row = rowsOf(await ui.drawn()).find(r => r.text.includes(text))
  if (row === undefined) throw new Error(`no row shows "${text}"`)
  return row.handle
}

/** The person moves the pane's ring onto `element` with Tab or the arrows. With none, the ring leaves the Buttons. */
export const focusOn = ($: Engine, element?: string) =>
  $.ui.focus({
    component: 'Pane',
    requestId: 'track',
    plugin: 'artifact-tracking',
    ...(element === undefined ? {} : { element }),
    origin: { kind: 'person' },
  } as never)

/**
 * Select the row that shows `text`: the ring moves onto its handle. The write of `selected` draws the pane again, as it
 * does live. A world with `isolateState` answers `state.set` itself and then nothing does, so draw once more here: the
 * footer keys read the selected row.
 */
export async function select($: Engine, ui: PaneUi, text: string): Promise<void> {
  await focusOn($, await handleFor(ui, text))
  await ui.redraw()
}

/** Waits for a text on the screen. A hang guard of 20 s, as `until` has: the limit is no speed limit. */
export async function seen(ui: PaneUi, text: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if ((await ui.find({ text })) !== undefined) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${text}`)
}

/** The keys of the Buttons on the screen, in the order they are drawn. */
export const buttonKeys = async (ui: PaneUi) => (await ui.findAll({ type: 'Button' })).map(b => b.key)

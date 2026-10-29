// Helpers to read what TreeDataTable.render draws: the plain-data tree of `{ type, props, children }` nodes, a table
// view with the defaults of a normal pane, and a recording TableActions. Node and kit tests use them alike.
import { footerKeys, KeyRegistry, viewKeys } from '../../core/infra/keys'
import { footerRows, moveHintFits } from '../../ux/tree-data-table/footer'
import type { TableActions, TableView } from '../../ux/tree-data-table/table'

export interface Node {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}

export const isNode = (x: unknown): x is Node => typeof x === 'object' && x !== null && 'type' in x

/** Every node of `type` below `tree` (itself included), depth first. */
export function nodes(tree: unknown, type: string): Node[] {
  if (!isNode(tree)) return []
  return [...(tree.type === type ? [tree] : []), ...tree.children.flatMap(c => nodes(c, type))]
}

/** The string leaves below `node`, in order. */
export function leaves(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  return isNode(node) ? node.children.flatMap(leaves) : []
}

/** The Boxes of the detail lines of an open row: they hold a Text that wraps. */
export const detailBoxes = (tree: unknown): Node[] =>
  nodes(tree, 'Box').filter(b => b.children.some(c => isNode(c) && c.type === 'Text' && c.props.wrap === 'wrap'))

/** The Texts that hold exactly one string child, as `[props, string]`. */
export const texts = (tree: unknown): [Node['props'], string][] =>
  nodes(tree, 'Text')
    .filter(t => t.children.length === 1 && typeof t.children[0] === 'string')
    .map(t => [t.props, t.children[0] as string])

/** The child Boxes of a section Box that draw a row: the first child is the gutter Text and a row handle sits inside. */
export function rowBoxes(tree: unknown): Node[] {
  return nodes(tree, 'Box').filter(b => {
    const first = b.children[0]
    const gutter = isNode(first) && first.type === 'Text' && (first.children[0] === ' ' || first.children[0] === '>')
    return gutter && nodes(b, 'Button').some(x => /^r\d+$/.test(String(x.props.key)))
  })
}

/** How many rows of the drawing carry the mark star. */
export const starsOf = (tree: unknown): number => rowBoxes(tree).filter(b => leaves(b).includes('*')).length

/** The text of the view line, or the bulk question that takes its place. */
export const viewWords = (tree: unknown): string | undefined =>
  texts(tree).find(([, s]) => s.startsWith('View:') || s.startsWith('Dismiss '))?.[1]

/** The row handles, in drawing order. */
export const handlesOf = (tree: unknown): string[] =>
  nodes(tree, 'Button')
    .map(b => String(b.props.key))
    .filter(k => /^r\d+$/.test(k))

/**
 * The Button keys of `g`, `a`, `t` (issue #63, L3), `p` (issue #199) and `m` (issue #138). In the pane they sit on the view line and
 * are no footer keys. The help view has no view line: it draws the same Buttons in its footer, dim (issue #200, `helpFooterOf`).
 */
export const VIEW_LINE_KEYS: readonly string[] = ['view', 'show-all', 'touched', 'clean', 'mark']

/** The keys of the view line as the pane draws them on a row that takes every bulk key: all of them live. */
export const LIVE_VIEW_KEYS = viewKeys(
  new KeyRegistry(),
  { id: 'a', owner: 'web', group: 's', can: { dismiss: true, priority: true } },
  owner => owner === 'web',
  false,
)

/**
 * The footer Buttons of the pane: the ones with a hotkey that are not on the view line. Do not use it on the help view: its
 * footer holds the keys of the view line too (`helpFooterOf`), and this leaves them out.
 */
export const footerOf = (tree: unknown): Node[] =>
  nodes(tree, 'Button').filter(b => b.props.hotkey !== undefined && !VIEW_LINE_KEYS.includes(String(b.props.key)))

/**
 * The footer Buttons of the help view: every Button with a hotkey. The help view has no view line (issue #200), so `g`, `a`, `t`,
 * `p` and `m` are footer Buttons there, after `0`.
 */
export const helpFooterOf = (tree: unknown): Node[] => nodes(tree, 'Button').filter(b => b.props.hotkey !== undefined)

/** The Buttons of the view line, in order. */
export const viewLineOf = (tree: unknown): Node[] =>
  nodes(tree, 'Button').filter(b => VIEW_LINE_KEYS.includes(String(b.props.key)))

/** The one Button with this key. */
export function buttonOf(tree: unknown, key: string): Node {
  const hit = nodes(tree, 'Button').filter(b => b.props.key === key)
  if (hit.length !== 1) throw new Error(`expected one Button ${key}, found ${hit.length}`)
  return hit[0] as Node
}

/** Press a Button the way the engine does: with the press event, which names the surface the press came from. */
export const press = (b: Node, surface?: string): void =>
  (b.props.onPress as (e?: { surface: string }) => void)(surface === undefined ? undefined : { surface })

/** The footer of a pane with no row selected. */
export const NO_ROW_FOOTER = footerKeys(new KeyRegistry(), undefined, () => false, false)

/** The footer of the help view with no row selected: 12 Buttons since issue #199, the last five dim (`g`, `a`, `t`, `p` and `m`). */
export const HELP_FOOTER = footerKeys(new KeyRegistry(), undefined, () => false, true)

/**
 * The rows `HELP_FOOTER` takes in the 96-cell body of an inline pane: 2 since issue #200. A fit test of the help view takes
 * this, not a literal row count, so a key that wraps the footer moves its budget and the test fails (issue #265).
 */
export const HELP_FOOTER_ROWS = footerRows(HELP_FOOTER, 96, moveHintFits(HELP_FOOTER, 96))

/** A view with the defaults of a normal pane: 80 columns, no body height, nothing selected, nothing opened, 50 rows per section. */
export function view(over: Partial<TableView> = {}): TableView {
  return {
    bodyColumns: 80,
    bodyRows: undefined,
    selected: null,
    expanded: new Set(),
    shown: () => 0,
    limits: { sectionRows: 50, maxRows: 300 },
    footer: NO_ROW_FOOTER,
    help: null,
    ...over,
  }
}

/**
 * `calls` lists each action as `toggle:<id>`, `more:<section>` or `press:<buttonKey>`. `asks` counts the presses that only
 * ask for the keys (a dim footer key), which are not work.
 */
export function recorder(): {
  calls: string[]
  surfaces: (string | undefined)[]
  asks: { count: number }
  actions: TableActions
} {
  const calls: string[] = []
  const surfaces: (string | undefined)[] = []
  const asks = { count: 0 }
  return {
    calls,
    surfaces,
    asks,
    actions: {
      toggle: id => void calls.push(`toggle:${id}`),
      more: id => void calls.push(`more:${id}`),
      press: (key, surface) => {
        calls.push(`press:${key}`)
        surfaces.push(surface)
      },
      keys: () => void asks.count++,
    },
  }
}

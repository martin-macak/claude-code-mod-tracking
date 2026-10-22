// Helpers to read what TreeDataTable.render draws: the plain-data tree of `{ type, props, children }` nodes, a table
// view with the defaults of a normal pane, and a recording TableActions. Node and kit tests use them alike.
import { footerKeys, KeyRegistry } from '../../core/infra/keys'
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

/** The row handles, in drawing order. */
export const handlesOf = (tree: unknown): string[] =>
  nodes(tree, 'Button')
    .map(b => String(b.props.key))
    .filter(k => /^r\d+$/.test(k))

/** The Button keys of the view line: `g`, `a` and `t` (issue #63, L3). Their Buttons have hotkeys, but they are no footer keys. */
export const VIEW_LINE_KEYS: readonly string[] = ['view', 'show-all', 'touched']

/** The footer Buttons: the ones with a hotkey that are not on the view line. */
export const footerOf = (tree: unknown): Node[] =>
  nodes(tree, 'Button').filter(b => b.props.hotkey !== undefined && !VIEW_LINE_KEYS.includes(String(b.props.key)))

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

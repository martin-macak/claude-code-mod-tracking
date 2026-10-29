// KeyRegistry and the key routing. The registry collects the core keys and each tracker's static keys at init and drops
// an invalid or taken key with a problem: the engine lets the later of two equal hotkeys win in silence (E11). `route`
// says where a pressed key goes. `footerKeys` says which Buttons the footer draws and which are live.
// Imports only core/interfaces. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Keys".
// Plan: L6 Task 6, G6, G7, G16.

import type { Level } from '../interfaces/items'
import type { PreviewMode } from '../interfaces/preview'
import type { KeySpec } from '../interfaces/tracker'
import type { FooterKey, PaneKey, RowRef } from '../interfaces/view'

const core = (id: string, key: string, label: string, scope: PaneKey['scope'], bar?: PaneKey['bar']): PaneKey => ({
  id,
  key,
  label,
  scope,
  owner: 'core',
  ...(bar === undefined ? {} : { bar }),
})

/**
 * The keys of the pane, in footer order. `x` and `0`-`3` act on the selected row, or on the marked rows while a marked row is
 * drawn (issue #138). `g`, `a` and `t` (issue #63, L3) work on the whole pane and sit on the view line, not in the footer: the
 * footer keeps the rows it has. `p` (issue #199) shows the plan of `/track clean` in the pane and changes nothing; it sits there
 * too. `m` marks the selected row and sits there too: on the view line it adds no footer row (issue #138).
 * The help view has no view line, so it draws these five keys in its footer, dim (issue #200, `footerKeys`).
 * `x` carries `confirm`: on many rows it asks first, and the pane reads the flag, not the id.
 * The label of `t` is `touched`, not `touched only` (issue #199, owner decision Q5). The case that `tests/help.test.ts` pins (3 config
 * problems, a 90-cell path, the keys of two trackers) takes 10 rows of the 11-row inline body beside a footer of 1 row, and
 * 11 beside the footer of 2 rows that issue #200 draws. With `touched only` it takes 11 and 12, so the second would not fit.
 *
 * `v` and `d` are the keys of the preview (issue #57, L2). `v` opens the preview of the selected row and sits last of the footer keys,
 * but only for a row whose tracker has a preview. `d` is the diff mode and sits on the key line of the preview, so it is on no footer.
 * Core takes both: no tracker can, so a second provider never meets a key that the registry turned off. `mode` is the one table of
 * the modes: the key that picks a mode names it. The key line, the press and the route read it, so a mode that core adds later
 * (issue #275, `detail`) is one more entry here.
 */
export const CORE_KEYS: readonly PaneKey[] = [
  core('refresh', 'r', 'refresh', 'pane'),
  core('help', 'h', 'help', 'pane'),
  core('view', 'g', 'view', 'pane', 'view'),
  core('show-all', 'a', 'show all', 'pane', 'view'),
  core('touched', 't', 'touched', 'pane', 'view'),
  core('clean', 'p', 'clean plan', 'pane', 'view'),
  core('mark', 'm', 'mark', 'row', 'view'),
  { ...core('dismiss', 'x', 'dismiss', 'row'), confirm: true },
  core('prio-1', '1', 'high', 'row'),
  core('prio-2', '2', 'normal', 'row'),
  core('prio-3', '3', 'low', 'row'),
  core('prio-0', '0', 'auto', 'row'),
  { ...core('preview', 'v', 'preview', 'row'), mode: 'view' },
  { ...core('diff', 'd', 'diff', 'row', 'preview'), mode: 'diff' },
]

/** The level each priority key sets. `0` is `auto`: it removes the person's mark. */
export const PRIO_LEVEL: Readonly<Record<string, Level | undefined>> = {
  'prio-1': 'high',
  'prio-2': 'normal',
  'prio-3': 'low',
  'prio-0': undefined,
}

const VALID_KEY = /^[a-z0-9]$/

/** The footer Button key: a core key is its id, a tracker key is `<owner>.<id>`. */
export function buttonKeyOf(k: PaneKey): string {
  return k.owner === 'core' ? k.id : `${k.owner}.${k.id}`
}

export class KeyRegistry {
  private readonly list: PaneKey[] = []
  /** The owners whose tracker has a `preview`: only their rows draw `v` (issue #57, L2). */
  private readonly previews = new Set<string>()
  private readonly byButton = new Map<string, PaneKey>()
  private readonly byKey = new Map<string, PaneKey>()
  private readonly notes: string[] = []

  constructor(coreKeys: readonly PaneKey[] = CORE_KEYS) {
    for (const k of coreKeys) this.keep(k)
  }

  /** Adds a tracker's keys. A key that is not one of `a-z` or `0-9`, a taken key and a repeated id are dropped with a problem. */
  add(owner: string, specs: readonly KeySpec[]): void {
    for (const s of specs) {
      const key = s.key.toLowerCase()
      if (!VALID_KEY.test(key)) {
        this.notes.push(
          `keys: ${owner} key "${s.key}" (${s.id}) is not one letter a-z or one digit 0-9. The key is off.`,
        )
        continue
      }
      const first = this.byKey.get(key)
      if (first !== undefined) {
        this.notes.push(
          `keys: ${owner} key "${key}" (${s.id}) is taken by ${first.owner} (${first.id}). The key is off.`,
        )
        continue
      }
      const made: PaneKey = { id: s.id, key, label: s.label, scope: s.scope, owner }
      if (this.byButton.has(buttonKeyOf(made))) {
        this.notes.push(
          `keys: ${owner} key "${key}" (${s.id}) repeats the key id "${s.id}" of ${owner}. The key is off.`,
        )
        continue
      }
      this.keep(made)
    }
  }

  /** Says that the tracker `owner` has a `preview`, so a row of it draws `v`. A tracker that is off or failed is never named. */
  addPreview(owner: string): void {
    this.previews.add(owner)
  }

  hasPreview(owner: string): boolean {
    return this.previews.has(owner)
  }

  /** Core first, then the tracker keys in add order. */
  all(): readonly PaneKey[] {
    return this.list
  }

  /** By footer Button key. */
  get(buttonKey: string): PaneKey | undefined {
    return this.byButton.get(buttonKey)
  }

  problems(): readonly string[] {
    return this.notes
  }

  private keep(k: PaneKey): void {
    this.list.push(k)
    this.byButton.set(buttonKeyOf(k), k)
    this.byKey.set(k.key, k)
  }
}

export type Route =
  | { readonly to: 'refresh' }
  | { readonly to: 'help' }
  | { readonly to: 'view' }
  | { readonly to: 'showAll' }
  | { readonly to: 'touched' }
  | { readonly to: 'clean' }
  | { readonly to: 'mark'; readonly rowId: string }
  | { readonly to: 'preview'; readonly rowId: string; readonly owner: string; readonly mode: string }
  | { readonly to: 'dismiss'; readonly rowId: string }
  | { readonly to: 'priority'; readonly rowId: string; readonly level: Level | undefined }
  | { readonly to: 'owner'; readonly owner: string; readonly id: string; readonly rowId: string | null }
  | { readonly to: 'none' }

const NONE: Route = { to: 'none' }

/** Whether a row takes a core row key: `x` needs `can.dismiss`, a digit needs `can.priority` and an item owner. */
const allowsDismiss = (row: RowRef): boolean => row.can?.dismiss === true
const allowsPriority = (row: RowRef, isItemOwner: (owner: string) => boolean): boolean =>
  row.can?.priority === true && isItemOwner(row.owner)

/**
 * The core row keys that also have a bulk form (issue #138), by key id: `x` and the digits. One entry says which rows the key takes,
 * what it does to the selected row (`route`) and what it does to the marked rows (`bulkTargets`), so the two cannot take different
 * rows. A new bulk key adds its entry here, a member to `Bulk` and a case to `PaneSession.bulk`: `tsc` fails until that case exists.
 */
interface RowKey {
  readonly allows: (row: RowRef, isItemOwner: (owner: string) => boolean) => boolean
  readonly one: (rowId: string) => Route
  readonly many: (rowIds: readonly string[]) => Bulk
}

const ROW_KEYS: Readonly<Record<string, RowKey>> = {
  dismiss: {
    allows: allowsDismiss,
    one: rowId => ({ to: 'dismiss', rowId }),
    many: rowIds => ({ to: 'dismiss', rowIds }),
  },
  ...Object.fromEntries(
    Object.entries(PRIO_LEVEL).map(([id, level]): [string, RowKey] => [
      id,
      {
        allows: allowsPriority,
        one: rowId => ({ to: 'priority', rowId, level }),
        many: rowIds => ({ to: 'priority', rowIds, level }),
      },
    ]),
  ),
}

const rowKeyOf = (id: string): RowKey | undefined => (Object.hasOwn(ROW_KEYS, id) ? ROW_KEYS[id] : undefined)

/**
 * Where a pressed key goes, given the selected row. `refresh`, `help` and the pane keys of the view line (`g`, `a`, `t`, `p`) always route:
 * `p` shows the plan of `/track clean` and needs no row (issue #199). `x` needs
 * `can.dismiss` on the row: the owner hears the dismiss through the dismiss list (G7). `0`-`3` need an item owner and
 * `can.priority`. `m` needs a row that takes one of those, so a mark always has a bulk key to act with, or a row that is marked
 * already, which `isMarked` says: it can always be unmarked. A tracker key goes to its owner while one of its rows is selected.
 * An absent `can` flag counts as false.
 */
export function route(
  k: PaneKey,
  row: RowRef | undefined,
  isItemOwner: (owner: string) => boolean,
  isMarked = false,
): Route {
  if (k.owner !== 'core') {
    return row !== undefined && row.owner === k.owner ? { to: 'owner', owner: k.owner, id: k.id, rowId: row.id } : NONE
  }
  if (k.id === 'refresh') return { to: 'refresh' }
  if (k.id === 'help') return { to: 'help' }
  if (k.id === 'view') return { to: 'view' }
  if (k.id === 'show-all') return { to: 'showAll' }
  if (k.id === 'touched') return { to: 'touched' }
  if (k.id === 'clean') return { to: 'clean' }
  if (row === undefined) return NONE
  // A key with a mode and no bar opens the preview in that mode: `v`. It routes for any row. The footer draws it only for an owner that
  // has a preview (`footerKeys`), so no other row presses it. `d` is a key of the preview line (`bar`): the list has no Button for it.
  if (k.mode !== undefined && k.bar === undefined)
    return { to: 'preview', rowId: row.id, owner: row.owner, mode: k.mode }
  if (k.id === 'mark') {
    return isMarked || allowsDismiss(row) || allowsPriority(row, isItemOwner) ? { to: 'mark', rowId: row.id } : NONE
  }
  const rowKey = rowKeyOf(k.id)
  return rowKey?.allows(row, isItemOwner) ? rowKey.one(row.id) : NONE
}

/** The ids of the rows that `allows`, once each, in the order given. */
const idsOf = (rows: readonly RowRef[], allows: (row: RowRef) => boolean): readonly string[] => [
  ...new Set(rows.filter(allows).map(row => row.id)),
]

/** The marked rows that `x` takes: those with `can.dismiss`, once each. */
export const dismissTargets = (markedRows: readonly RowRef[]): readonly string[] => idsOf(markedRows, allowsDismiss)

/**
 * What a core row key does to many rows at once: the rows it takes, and the work. A new bulk key adds a member here, an entry to
 * `ROW_KEYS` (which `bulkTargets` reads) and a case to the `switch` in `PaneSession.bulk`. That `switch` ends in `satisfies never`,
 * so `tsc` fails until the case exists, and the key cannot reach the dismiss of another case by falling through.
 */
export type Bulk =
  | { readonly to: 'dismiss'; readonly rowIds: readonly string[] }
  | { readonly to: 'priority'; readonly rowIds: readonly string[]; readonly level: Level | undefined }

/**
 * What a core row key does to the marked rows while rows are marked (issue #138): the marked rows that allow the key, once each,
 * in the order given. `undefined`: the key has no bulk form (a pane key, `m`, a tracker key), or no marked row is drawn, so
 * the key acts on the selected row (`route`). No `rowIds`: marked rows are drawn and none allows the key, so it is dim and
 * does nothing. Marks win: it never falls back to the selected row, else two marked repo rows and a `1` would set the
 * priority of the unmarked row that happens to be selected.
 */
export function bulkTargets(
  k: PaneKey,
  markedRows: readonly RowRef[],
  isItemOwner: (owner: string) => boolean,
): Bulk | undefined {
  if (markedRows.length === 0 || k.owner !== 'core') return undefined
  const rowKey = rowKeyOf(k.id)
  return rowKey?.many(idsOf(markedRows, row => rowKey.allows(row, isItemOwner)))
}

/** True for a key whose Button sits on the view line (`bar: 'view'`): the pane draws it there, the help view in its footer. */
const onViewLine = (k: PaneKey): boolean => k.bar === 'view'

/**
 * The footer Buttons: the core keys, then the keys of the selected row's owner. Every key stays on the footer. A key
 * with no route, or whose owner says `disabled`, draws dim and does nothing (a letter with no Button leaves the pane).
 * While `markedRows` are drawn, `x` and the digits are live when a marked row allows them, whatever the selected row is,
 * and dim when none does (`bulkTargets`). The keys of a tracker stay on the selected row.
 * In the help view only `r` and `h` work, and `h` reads `back`. The help view has no view line, so its footer also holds
 * every key of the view line (`bar: 'view'`: `g`, `a`, `t`, `p` and `m`), last and dim: a press does nothing and takes the keys, so
 * the letter does not type into the prompt (issue #200). The rule reads `bar`, not a list of letters, so a new key of the view
 * line gets its dim Button with no edit here. They come after `0`, so the Tab walk and the first stop do not move. A key of
 * the key line of the preview (`bar: 'preview'`: `d`) is on neither footer: the preview draws it.
 *
 * A key that opens the preview (`v`) is drawn only for a row whose owner has a preview. It is live when the row itself has one
 * (`previewable`, from the `modes()` of the provider): a provider that previews some rows only gets a dim `v` on the others.
 */
export function footerKeys(
  reg: KeyRegistry,
  row: RowRef | undefined,
  isItemOwner: (owner: string) => boolean,
  help: boolean,
  state?: (owner: string, id: string) => 'enabled' | 'disabled',
  markedRows: readonly RowRef[] = [],
  previewable = true,
): readonly FooterKey[] {
  const shown = reg
    .all()
    .filter(
      k =>
        k.bar === undefined &&
        (k.mode === undefined || (row !== undefined && reg.hasPreview(row.owner))) &&
        (k.owner === 'core' || (row !== undefined && k.owner === row.owner)),
    )
  const dimmed = help ? reg.all().filter(onViewLine) : [] // the help view has no view line: its keys stay as dim Buttons
  return [...shown, ...dimmed].map(k => {
    const core = k.owner === 'core'
    const bulk = bulkTargets(k, markedRows, isItemOwner)
    const routed =
      bulk === undefined
        ? route(k, row, isItemOwner).to !== 'none' && (k.mode === undefined || previewable)
        : bulk.rowIds.length > 0
    const live = help
      ? core && (k.id === 'refresh' || k.id === 'help')
      : routed && (core || state?.(k.owner, k.id) !== 'disabled')
    return { ...k, label: help && core && k.id === 'help' ? 'back' : k.label, enabled: live, buttonKey: buttonKeyOf(k) }
  })
}

/**
 * The footer of the plan view (issue #199): a Button for every core key, in registry order. The plan view is a text view with no
 * view line, so a key with no Button would leave the pane for the prompt (`g`, `a`, `t` and `m` would type into it). Only `p` and `r`
 * work: `p` reads `back` and leaves the view, `r` reads the plan again. Every other key is a dim Button that does no work. It needs no
 * row, so it holds no key of a tracker, as the footer of the help view holds none. It does not read the help footer, so a change of
 * that footer cannot change it. A key that picks a mode of the preview (`v` and `d`, issue #57, L2) has no Button here either, as it has
 * none in the footer of the help view: it needs a row, and the plan view draws none. It keeps the footer at the rows that its tests pin.
 */
export function planFooter(reg: KeyRegistry): readonly FooterKey[] {
  return reg
    .all()
    .filter(k => k.owner === 'core' && k.mode === undefined)
    .map(k => ({
      ...k,
      label: k.id === 'clean' ? 'back' : k.label,
      enabled: k.id === 'clean' || k.id === 'refresh',
      buttonKey: buttonKeyOf(k),
    }))
}

/** The Button keys of the view line, whatever their state: what the refocus compares. */
export const viewButtonKeys = (reg: KeyRegistry): readonly string[] => reg.all().filter(onViewLine).map(buttonKeyOf)

/**
 * The keys of the view line: `g`, `a`, `t` (issue #63, L3), `p` (issue #199) and `m` (issue #138), in registry order. The line is
 * drawn in the pane only: the help view and the plan view have none, so their caller does not ask. The help footer draws these keys
 * as dim Buttons (issue #200, `footerKeys`), and so does the plan footer (`planFooter`). `buttonKey` is the key of the Button on the
 * line. `g`, `a`, `t` and `p` are always live. `m` is live on a row that takes a bulk key, or that is marked (`isMarked`, see
 * `route`), and dim on another row and with no row.
 */
export function viewKeys(
  reg: KeyRegistry,
  row: RowRef | undefined,
  isItemOwner: (owner: string) => boolean,
  isMarked: boolean,
): readonly FooterKey[] {
  return reg
    .all()
    .filter(onViewLine)
    .map(k => ({
      ...k,
      enabled: k.id !== 'mark' || route(k, row, isItemOwner, isMarked).to !== 'none',
      buttonKey: buttonKeyOf(k),
    }))
}

/**
 * The Buttons of the key line of the preview (issue #57, L2): one for each mode of the row in the order the provider lists them
 * (`v: view`, `d: diff`), then `r: reload`. `r` is the core key `refresh` with another word: one `r` in the tree, so the engine
 * never meets two hotkeys, and the press asks for the preview again while the preview shows. A mode that is off draws dim. The core key
 * of a mode is the one that names it in `PaneKey.mode`: a mode that no core key picks has no Button. `buttonKey` is the key of the
 * Button: the registry finds the core key by it.
 */
export function previewKeys(reg: KeyRegistry, modes: readonly PreviewMode[]): readonly FooterKey[] {
  const keys: FooterKey[] = []
  for (const mode of modes) {
    const key = reg.all().find(k => k.owner === 'core' && k.mode === mode.id)
    if (key !== undefined) keys.push({ ...key, label: mode.id, enabled: mode.enabled, buttonKey: buttonKeyOf(key) })
  }
  const reload = reg.get('refresh')
  if (reload !== undefined) keys.push({ ...reload, label: 'reload', enabled: true, buttonKey: buttonKeyOf(reload) })
  return keys
}

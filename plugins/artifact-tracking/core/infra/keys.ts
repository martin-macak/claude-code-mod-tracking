// KeyRegistry and the key routing. The registry collects the core keys and each tracker's static keys at init and drops
// an invalid or taken key with a problem: the engine lets the later of two equal hotkeys win in silence (E11). `route`
// says where a pressed key goes. `footerKeys` says which Buttons the footer draws and which are live.
// Imports only core/interfaces. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Keys".
// Plan: L6 Task 6, G6, G7, G16.

import type { Level } from '../interfaces/items'
import type { KeySpec } from '../interfaces/tracker'
import type { FooterKey, PaneKey, RowRef } from '../interfaces/view'

const core = (id: string, key: string, label: string, scope: PaneKey['scope']): PaneKey => ({
  id,
  key,
  label,
  scope,
  owner: 'core',
})

/** The keys of the pane, in footer order. `x` and `0`-`3` act on the selected row. */
export const CORE_KEYS: readonly PaneKey[] = [
  core('refresh', 'r', 'refresh', 'pane'),
  core('help', 'h', 'help', 'pane'),
  core('dismiss', 'x', 'dismiss', 'row'),
  core('prio-1', '1', 'high', 'row'),
  core('prio-2', '2', 'normal', 'row'),
  core('prio-3', '3', 'low', 'row'),
  core('prio-0', '0', 'auto', 'row'),
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
  | { readonly to: 'dismiss'; readonly rowId: string }
  | { readonly to: 'priority'; readonly rowId: string; readonly level: Level | undefined }
  | { readonly to: 'owner'; readonly owner: string; readonly id: string; readonly rowId: string | null }
  | { readonly to: 'none' }

const NONE: Route = { to: 'none' }

/**
 * Where a pressed key goes, given the selected row. `refresh` and `help` always route. `x` needs `can.dismiss` on the
 * row: the owner hears the dismiss through the dismiss list (G7). `0`-`3` need an item owner and `can.priority`. A tracker
 * key goes to its owner while one of its rows is selected. An absent `can` flag counts as false.
 */
export function route(k: PaneKey, row: RowRef | undefined, isItemOwner: (owner: string) => boolean): Route {
  if (k.owner !== 'core') {
    return row !== undefined && row.owner === k.owner ? { to: 'owner', owner: k.owner, id: k.id, rowId: row.id } : NONE
  }
  if (k.id === 'refresh') return { to: 'refresh' }
  if (k.id === 'help') return { to: 'help' }
  if (row === undefined) return NONE
  if (k.id === 'dismiss') return row.can?.dismiss === true ? { to: 'dismiss', rowId: row.id } : NONE
  if (Object.hasOwn(PRIO_LEVEL, k.id)) {
    return row.can?.priority === true && isItemOwner(row.owner)
      ? { to: 'priority', rowId: row.id, level: PRIO_LEVEL[k.id] }
      : NONE
  }
  return NONE
}

/**
 * The footer Buttons: the core keys, then the keys of the selected row's owner. Every key stays on the footer. A key
 * with no route, or whose owner says `disabled`, draws dim and does nothing (a letter with no Button leaves the pane).
 * In the help view only `r` and `h` work, and `h` reads `back`.
 */
export function footerKeys(
  reg: KeyRegistry,
  row: RowRef | undefined,
  isItemOwner: (owner: string) => boolean,
  help: boolean,
  state?: (owner: string, id: string) => 'enabled' | 'disabled',
): readonly FooterKey[] {
  const shown = reg.all().filter(k => k.owner === 'core' || (row !== undefined && k.owner === row.owner))
  return shown.map(k => {
    const core = k.owner === 'core'
    const live = help
      ? core && (k.id === 'refresh' || k.id === 'help')
      : route(k, row, isItemOwner).to !== 'none' && (core || state?.(k.owner, k.id) !== 'disabled')
    return { ...k, label: help && core && k.id === 'help' ? 'back' : k.label, enabled: live }
  })
}

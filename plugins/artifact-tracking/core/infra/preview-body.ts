// The Buttons of the body of the preview (issue #277, B6): the `↩ back` Button, the key line of a mode and the dim keys of the detail
// view. What the drawing and the refocus both name, so they cannot drift. Pure: no `$`, no I/O. The registry and the routing stay in
// `keys.ts`; this module only lays out the Buttons of one view.

import type { PreviewMode, PreviewModeId } from '../interfaces/preview'
import type { FooterKey } from '../interfaces/view'
import { DETAIL_MODE } from '../lib/preview'
import { buttonKeyOf, type KeyRegistry, previewKeys } from './keys'

/** The key of the `↩ back` Button of the preview body: it is no `PaneKey` (it has no letter), so the ring and the refocus name it. */
export const BACK_BUTTON = 'back'

/**
 * The dim Buttons under the key line of the preview (the rule of issue #200 for a view that is no list): every core key that the key
 * line `line` does not draw, then the keys of the tracker that owns the row. The preview has no footer and no view line, so a letter
 * with no Button would leave the pane for the prompt. A press does nothing and gives the pane the keys. The line draws `r` and the
 * modes that the row lists, so a row with no `v` or no `d` mode gets a dim `v` or `d` (PR 302, M1). The rule reads the registry, so a
 * new core key gets its dim Button with no edit here.
 */
function dimKeys(reg: KeyRegistry, owner: string | undefined, line: readonly FooterKey[]): readonly FooterKey[] {
  return reg
    .all()
    .filter(k => (k.owner === 'core' || k.owner === owner) && !line.some(l => l.id === k.id))
    .map(k => ({ ...k, enabled: false, buttonKey: buttonKeyOf(k) }))
}

/** The Buttons of a preview body for one mode. `dim` is the detail view's (issue #277): a file mode keeps the key line of issue #57. */
export interface PreviewBody {
  readonly keys: readonly FooterKey[]
  /** The dim keys under the key line. Set in the detail view only, which also draws `↩ back`. */
  readonly dim: readonly FooterKey[] | undefined
  /** The Button keys in drawing order: `↩ back` first in the detail view (the ring goes to the first Button), the key line, the dim keys. */
  readonly buttons: readonly string[]
}

export function previewBody(
  reg: KeyRegistry,
  modes: readonly PreviewMode[],
  mode: PreviewModeId,
  owner: string,
): PreviewBody {
  const keys = previewKeys(reg, modes, mode)
  if (mode !== DETAIL_MODE) return { keys, dim: undefined, buttons: keys.map(k => k.buttonKey) }
  const dim = dimKeys(reg, owner, keys)
  return { keys, dim, buttons: [BACK_BUTTON, ...keys.map(k => k.buttonKey), ...dim.map(k => k.buttonKey)] }
}

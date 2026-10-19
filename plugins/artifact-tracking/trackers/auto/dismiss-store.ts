// The run-scoped dismiss list. It lives inside the `auto` member of the `trackers` family (AutoState.dismissed), so the
// list, the root and the proofs share one slot and one carry across a session switch (plan decision D2). Core sees it
// only as a DismissPort. Moved out of hooks/register.tsx. Plan: L3 Task 10.

import { dismiss } from '../../core/infra/dismiss'
import type { Json } from '../../core/interfaces/items'
import type { SlotPort } from '../../core/interfaces/ports'
import type { DismissPort } from '../../core/interfaces/tracker'
import type { AutoState } from '../../hooks/contracts'
import { emptyAuto } from './ledger'

export const AUTO_SLOT = 'auto'

/** The dismiss list over the `auto` slot. `add` also drops the rows of the ids (and an agent's subtree) from the snapshot. */
export function autoDismiss(slot: SlotPort): DismissPort {
  return {
    list: async () => new Set(((await slot.get(AUTO_SLOT)) as unknown as AutoState | undefined)?.dismissed ?? []),
    add: async ids => {
      await slot.update(
        AUTO_SLOT,
        cur => dismiss((cur as unknown as AutoState | undefined) ?? emptyAuto(), ids) as unknown as Json,
      )
    },
  }
}

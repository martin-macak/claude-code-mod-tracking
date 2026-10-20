// Why a thing is tracked: the closed vocabulary, the reasons a kind may add, and the interface of a tracker that keeps
// rows of its own. Types only. The algebra (the precedence, the merge, the check of a kind's reasons) is `core/lib/reasons.ts`.
// Issue #62. `CoreReason` and `ReasonSet` live in the PluginState contract (`types/index.d.ts`), because `StoredItem`
// holds a `ReasonSet`; they are re-exported here and from `./items`.

import type { CoreReason, ReasonSet } from '../../types'

export type { CoreReason, ReasonSet } from '../../types'

/**
 * A reason that one kind adds to the vocabulary, e.g. `reviewed` for a kind of reviews. It maps to one `CoreReason`, so a
 * filter or a prompt line that knows only the core words still reads it. A kind declares them in `ItemKind.reasons`.
 */
export interface KindReason {
  /** The word the kind uses. It is not a core reason. */
  readonly id: string
  /** The core reason a claim carries when the kind uses `id`. */
  readonly core: CoreReason
}

/**
 * A tracker that keeps rows of its own (a slot tracker: repos, processes, auto) and can say why each one is tracked. It
 * implements this beside `Tracker`. The answer derives from the signals the rows already hold: it adds no capture.
 */
export interface Traceable<D = unknown> {
  /** The reasons of the row `rowId` in the tracker's data. undefined: no such row, or a row that is context, not a find. */
  reasonsOf(data: D | undefined, rowId: string): ReasonSet | undefined
}

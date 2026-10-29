// State contract of the artifact-tracking mod.
// `claude plugin validate` reads the literal shape of PluginState. The file declares no tracker type: each tracker
// owns its record and slot types in `trackers/<id>/types.ts`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.9 and 5.13.

// ---------------------------------------------------------------- JSON

/** A JSON value. Arrays and objects are read-only, so a frozen config or a stored record fits. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject

/**
 * A JSON object. A tracker config type must be a `type` alias, not an `interface`:
 * only an alias has the implicit index signature that `C extends JsonObject` needs.
 */
export interface JsonObject {
  readonly [key: string]: Json | undefined
}

// ---------------------------------------------------------------- link scanner (copied from link-capture)

export type Via = 'inline' | 'autolink' | 'bare' | 'issue-ref' | 'reference' | 'image' | 'mailto' | 'osc8'

export type Captured = {
  url: string
  label?: string
  via: Via
  kind: 'link' | 'non-clickable'
  web: boolean
  door: string
  uuid: string
  agentId?: string
  n: number
}

// ---------------------------------------------------------------- why an item is tracked

/** Why an item is tracked, in one closed vocabulary: filters and prompt lines treat every kind the same (issue #62). */
export type CoreReason = 'created' | 'updated' | 'read' | 'deleted' | 'published' | 'discovered' | 'mentioned'

/**
 * The reasons of one item. `first`: the reason of the earliest sighting. `all`: every reason seen, strongest first (a
 * fixed order, so the same sightings give the same set whatever the order they merge in). `strongest`: the head of `all`.
 * A type alias, not an interface: only an alias has the implicit index signature that `Json` needs.
 */
export type ReasonSet = {
  readonly first: CoreReason
  readonly all: readonly CoreReason[]
  readonly strongest: CoreReason
}

// ---------------------------------------------------------------- tracked items

/** A priority level, highest first. `top` comes from a kind rule only. A person sets `high`, `normal` or `low`. */
export type Level = 'top' | 'high' | 'normal' | 'low'

/** One tracked item. The fields every kind shares are typed. The rest belong to the kind and stay flat. */
export interface StoredItem {
  /** The dedupe key, a stable id the owning kind makes, e.g. `note:42`. */
  readonly key: string
  /** The kind: the `category` of the `ItemKind` that owns the item. */
  readonly category: string
  /**
   * The channels it was seen in: `prompt`, `response`, `tool`, and nothing else. An item that only the PR lane found has
   * none: `reasons` holds `discovered` (issue #62).
   */
  readonly sources: readonly string[]
  /** Why it is tracked. */
  readonly reasons: ReasonSet
  readonly firstSeen: number
  readonly lastSeen: number
  /** Issue #69. The ordinal of the main-loop turn that first, and that last, tracked the item. Absent: no turn did (the PR lane found it, or the record is older than #69). */
  readonly firstTurn?: number
  readonly lastTurn?: number
  readonly priority?: Level
  /** Kind-owned fields. */
  readonly [field: string]: Json | undefined
}

// ---------------------------------------------------------------- turns (issue #69)

/** How a main-loop turn ended: the engine's own word (`TurnCompleteReason`). */
export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/**
 * One item that a turn tracked. `k` is the item key, `c` its category, `r` the strongest reason of the turn's claims for
 * it (#62). `late`: a subagent tracked it after the turn had ended. Short names: the ledger is stored once per session.
 */
export type TurnEntry = { readonly k: string; readonly c: string; readonly r: CoreReason; readonly late?: true }

/** One main-loop turn of the session, or of the sessions that `/clear` carried. A wake has none of its own. */
export type TurnRecord = {
  /** The number the person sees: `/track turn 7`. Counts on across `/clear`. */
  readonly ord: number
  /** The engine's id of the turn (`turn.start`). */
  readonly turnId: string
  /** The session id the turn ran in: a record of another id than the current one reads "earlier session". */
  readonly session: string
  /** Epoch ms, wall clock. */
  readonly startedAt: number
  readonly endedAt?: number
  /** Absent while the turn runs. */
  readonly end?: TurnEnd
  /** The first 60 characters of the person's prompt. Never in the prompt section. */
  readonly prompt?: string
  /** The items the turn added, and the known items it saw again. At most 50 each. */
  readonly new: readonly TurnEntry[]
  readonly seen: readonly TurnEntry[]
  /** Entries that did not fit the cap of their list. */
  readonly moreNew?: number
  readonly moreSeen?: number
  /** How often a finished task woke the main loop and put work into this turn. */
  readonly wakes?: number
  /**
   * The uuid of the `turn_duration` row of this turn (the engine appends it inside `turn.complete`, before the commit). The
   * `TurnDuration` line is drawn with this uuid as its `requestId`, so it finds its record by it (issue #69, P2). Absent
   * when no such row reached the mod: an aborted turn has none.
   */
  readonly durationRow?: string
}

/**
 * The turn ledger. `open`: the record that the running main turn writes to. `pending`: what the person's prompt row
 * tracked before its `turn.start` came (the row comes first); the turn adopts it. `wake`: a task notice seen on a
 * prompt row, read by the `turn.start` that follows. `agents` and `calls` map a subagent id and a main-loop tool call id
 * to the ordinal of the turn that started them; the oldest go first (200 each).
 */
export type TurnLedger = {
  /** The next ordinal. */
  readonly next: number
  readonly open?: { readonly ord: number; readonly turnId: string; readonly wake?: true }
  readonly pending?: {
    readonly ord: number
    /** The first 60 characters of the person's prompt row. */
    readonly prompt: string
    readonly new: readonly TurnEntry[]
    readonly seen: readonly TurnEntry[]
    readonly moreNew?: number
    readonly moreSeen?: number
  }
  readonly wake?: { readonly toolUseId?: string; readonly taskId?: string }
  /** Newest last, at most 50. */
  readonly turns: readonly TurnRecord[]
  readonly agents: readonly (readonly [agentId: string, ord: number])[]
  readonly calls: readonly (readonly [toolUseId: string, ord: number])[]
}

// ---------------------------------------------------------------- tools

export type BreakerState = 'closed' | 'open' | 'half-open'

export type ToolStatus = {
  /** The tool id, the same as the `ToolSpec.id` that declared it. */
  name: string
  /** null: not probed yet. */
  available: boolean | null
  version?: string
  /** null: unknown. false: a call proved the tool is not logged in. */
  loggedIn: boolean | null
  breaker: BreakerState
  /** When an open breaker may let one probe call through (epoch ms). */
  openUntil?: number
  lastError?: string
  lastRunAt?: number
  /** The site or account the tool acts on, when it has one. */
  site?: string
}

declare module 'claude-code' {
  interface PluginState {
    'artifact-tracking': {
      items: StoredItem[]
      /** One member per tracker id: a new tracker edits no line here. */
      trackers: StateFamily<Json>
      /** One status per tool id. */
      tools: Record<string, ToolStatus>
      /** L6. Ids of the rows whose open state differs from the row's default (the Enter presses). */
      expanded: string[]
      /** L6. The id of the selected row, `null` when none. Written from `ui.focus` and the row keys. */
      selected: string | null
      /** L6. Top-level rows shown beyond the cap, one member per section id. */
      shown: StateFamily<number>
      /** L6. The help view is on. */
      help: boolean
      /** Issue #69. What each main-loop turn tracked. Persisted per session, carried by `/clear`. */
      turns: TurnLedger
      /**
       * Issues #49 and #122. `showAll`: `/track show-all` is on, so the rows the TTL hides show again. `before`: the time of
       * the last `/track clean --hide`; a row that ended at or before it is hidden. Session scope, reset by `/clear`.
       */
      hidden: { showAll: boolean; before?: number }
      /** Issue #63, L3. The view the person chose (`g`, `/track view`), or `null` for `global.ui.view`. Session scope, reset by `/clear`. */
      view: string | null
      /** Issue #63, L3. The filters of the pane: `t` hides the rows nobody touched. Session scope, reset by `/clear`. */
      filters: { touchedOnly: boolean }
      /**
       * Issue #276. `e` (quick view): one flag for each form of the pane. The full form shows the quick view by default, the compact
       * form hides it. Session scope: a close and a reopen keep it, `/clear` resets it.
       */
      quick: { full: boolean; compact: boolean }
      /** Issue #138. The ids of the rows the person marked with `m`. Session scope: the pane clears it at close, `/clear` resets it. */
      marks: string[]
      /** Issue #57, L2. The preview the pane shows: a row id, its owner and a mode, never content. Session scope, reset by `/clear`. */
      preview: { rowId: string; owner: string; mode: string } | null
    }
  }
}

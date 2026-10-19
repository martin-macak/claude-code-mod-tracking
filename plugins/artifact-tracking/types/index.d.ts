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

// ---------------------------------------------------------------- tracked items

/** A priority level, highest first. `top` comes from a kind rule only. A person sets `high`, `normal` or `low`. */
export type Level = 'top' | 'high' | 'normal' | 'low'

/** One tracked item. The fields every kind shares are typed. The rest belong to the kind and stay flat. */
export interface StoredItem {
  /** The dedupe key, a stable id the owning kind makes, e.g. `note:42`. */
  readonly key: string
  /** The kind: the `category` of the `ItemKind` that owns the item. */
  readonly category: string
  /** Where it was seen, e.g. `prompt`, `response`, `tool`, `auto`. */
  readonly sources: readonly string[]
  readonly firstSeen: number
  readonly lastSeen: number
  readonly priority?: Level
  /** Kind-owned fields. */
  readonly [field: string]: Json | undefined
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

export type UiState = {
  /** Keys of folded tree rows (item keys or child node ids). */
  folded: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'artifact-tracking': {
      items: StoredItem[]
      /** One member per tracker id: a new tracker edits no line here. */
      trackers: StateFamily<Json>
      /** One status per tool id. */
      tools: Record<string, ToolStatus>
      ui: UiState
      /** L6. Ids of the rows whose open state differs from the row's default (the Enter presses). */
      expanded: string[]
      /** L6. The id of the selected row, `null` when none. Written from `ui.focus` and the row keys. */
      selected: string | null
      /** L6. Top-level rows shown beyond the cap, one member per section id. */
      shown: StateFamily<number>
      /** L6. The help view is on. */
      help: boolean
    }
  }
}

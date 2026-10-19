// Prompt sections: the types of the opt-in list of tracked items that the mod adds to the model's system prompt.
// Types only. The settings are the per-tracker `prompt` keys of the config file (spec 5.7). A section, a request and a
// trait mirror the engine's `PromptComposeSection`, `PromptComposeInput` and `PromptComposeTrait`, so the engine's own
// values fit them. A source is one tracker's contribution: its settings and a call that gives its lines.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.11. Plan: L7 Tasks 2 and 3.

/** What the user set for one tracker: whether its items go in the prompt and the most lines it may add. */
export interface PromptSettings {
  readonly enabled: boolean
  readonly maxItems: number
}

/** A branch the engine takes before it composes the prompt (the engine's closed set). */
export type PromptTrait =
  | 'bare'
  | 'lean'
  | 'sdk-preset'
  | 'teammate'
  | 'analysis'
  | 'print'
  | 'skills'
  | 'send-user-message'

/** One section of the system prompt: a stable id, the text the model reads and the side of the cache boundary. */
export interface PromptSection {
  readonly id: string
  readonly text: string
  readonly scope: 'shared' | 'session'
}

/** What a compose asks about. */
export interface PromptRequest {
  readonly traits: readonly PromptTrait[]
}

/** One tracker's lines for the prompt. `lines` may throw: the composer skips that source. */
export interface PromptSource {
  readonly id: string
  readonly settings: PromptSettings
  lines(): Promise<readonly string[]>
}

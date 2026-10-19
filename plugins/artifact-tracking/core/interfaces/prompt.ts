// Prompt sections: the types of the opt-in list of tracked items that the mod adds to the model's system prompt.
// Types only. The settings are the per-tracker `prompt` keys of the config file (spec 5.7); the rest is added with the composer.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.11. Plan: L7 Tasks 2 and 3.

/** What the user set for one tracker: whether its items go in the prompt and the most lines it may add. */
export interface PromptSettings {
  readonly enabled: boolean
  readonly maxItems: number
}

// The config of the questions tracker: its schema, its defaults and its `ConfigSpec` (issue #71).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7.

import { bool, type ConfigOf, int, type Schema, specOf } from '../../core/lib/normalise'
import { PROMPT_RULE } from '../../core/lib/prompt-config'

export const QUESTIONS_SCHEMA = {
  enabled: bool(true),
  /**
   * Masks the known secrets (the list is in the README) in what the pane shows and in `/track qa` and the copy key. The records
   * keep every word whatever this says. `false` shows them as typed.
   */
  mask: bool(true),
  /** The most calls that a session keeps. The oldest drop first. */
  maxCalls: int(100, 1, 1000),
  /** The most bytes (JSON characters) that the calls of a session take. The oldest drop first. */
  maxBytes: int(262144, 8192, 1048576),
  /**
   * The opt-in list of the calls in the model's system prompt. Off by default. When it is on, a line holds the headers and
   * the chosen labels only: never a question, a typed text or a note.
   */
  prompt: PROMPT_RULE,
} as const satisfies Schema

export type QuestionsConfig = ConfigOf<typeof QUESTIONS_SCHEMA>
export const questionsConfig = specOf(QUESTIONS_SCHEMA)
export const QUESTIONS_DEFAULTS: Readonly<QuestionsConfig> = questionsConfig.defaults

// The `prompt` block of a tracker slice: one rule for the five trackers that list items, and the reader of it that the
// composer uses. `promptSettings` re-checks its input, because the composer must survive a fake or a stale slice.
// Pure. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L7 Task 2 (S3, C1).

import type { PromptSettings } from '../interfaces/prompt'
import { isRecord } from './json'
import { bool, int, obj, type Schema } from './normalise'

/** The default and the bounds of `maxItems`: 5 trackers x 50 lines x 200 characters bound the text at 50,000. */
export const PROMPT_DEFAULT_MAX = 20
const MAX_MIN = 5
const MAX_MAX = 50

export const PROMPT_SCHEMA = {
  enabled: bool(false),
  maxItems: int(PROMPT_DEFAULT_MAX, MAX_MIN, MAX_MAX),
} as const satisfies Schema

/** The `prompt` key of a tracker schema. Off by default. */
export const PROMPT_RULE = obj(PROMPT_SCHEMA)

/** `enabled` is true only for `true`. `maxItems` is a whole number, clamped to 5..50, else the default. */
export function promptSettings(slice: Readonly<Record<string, unknown>>): PromptSettings {
  const raw = slice.prompt
  if (!isRecord(raw)) return { enabled: false, maxItems: PROMPT_DEFAULT_MAX }
  const n = raw.maxItems
  const whole = typeof n === 'number' && Number.isInteger(n)
  return {
    enabled: raw.enabled === true,
    maxItems: whole ? Math.min(MAX_MAX, Math.max(MAX_MIN, n)) : PROMPT_DEFAULT_MAX,
  }
}

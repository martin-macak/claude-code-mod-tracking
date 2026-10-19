// The config of the web tracker: `enabled` and the `prompt` block. Plan: L4 Task 2, L7 Task 2.

import { bool, type ConfigOf, type Schema, specOf } from '../../core/lib/normalise'
import { PROMPT_RULE } from '../../core/lib/prompt-config'

export const WEB_SCHEMA = { enabled: bool(true), prompt: PROMPT_RULE } as const satisfies Schema

export type WebConfig = ConfigOf<typeof WEB_SCHEMA>
export const webConfig = specOf(WEB_SCHEMA)
export const WEB_DEFAULTS: Readonly<WebConfig> = webConfig.defaults

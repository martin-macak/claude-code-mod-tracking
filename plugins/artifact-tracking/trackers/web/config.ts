// The config of the web tracker: only `enabled`. Plan: L4 Task 2.

import { bool, type ConfigOf, type Schema, specOf } from '../../core/lib/normalise'

export const WEB_SCHEMA = { enabled: bool(true) } as const satisfies Schema

export type WebConfig = ConfigOf<typeof WEB_SCHEMA>
export const webConfig = specOf(WEB_SCHEMA)
export const WEB_DEFAULTS: Readonly<WebConfig> = webConfig.defaults

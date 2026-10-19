// The config of the artifact tracker: `enabled` and the `prompt` block. Plan: L4 Task 2, L7 Task 2.

import { bool, type ConfigOf, type Schema, specOf } from '../../core/lib/normalise'
import { PROMPT_RULE } from '../../core/lib/prompt-config'

export const ARTIFACT_SCHEMA = { enabled: bool(true), prompt: PROMPT_RULE } as const satisfies Schema

export type ArtifactConfig = ConfigOf<typeof ARTIFACT_SCHEMA>
export const artifactConfig = specOf(ARTIFACT_SCHEMA)
export const ARTIFACT_DEFAULTS: Readonly<ArtifactConfig> = artifactConfig.defaults

// The config of the artifact tracker: only `enabled`. Plan: L4 Task 2.

import { bool, type ConfigOf, type Schema, specOf } from '../../core/lib/normalise'

export const ARTIFACT_SCHEMA = { enabled: bool(true) } as const satisfies Schema

export type ArtifactConfig = ConfigOf<typeof ARTIFACT_SCHEMA>
export const artifactConfig = specOf(ARTIFACT_SCHEMA)
export const ARTIFACT_DEFAULTS: Readonly<ArtifactConfig> = artifactConfig.defaults

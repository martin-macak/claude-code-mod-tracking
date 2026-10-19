// The config of the file tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. The default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import { bool, type ConfigOf, int, type Schema, specOf } from '../../core/lib/normalise'

export const FILE_SCHEMA = {
  enabled: bool(true),
  /** `.md` paths read from one prompt or reply row. Each one costs a stat. 0 reads none (issue #28). */
  maxMentionsPerRow: int(20, 0, 200),
} as const satisfies Schema

export type FileConfig = ConfigOf<typeof FILE_SCHEMA>
export const fileConfig = specOf(FILE_SCHEMA)
export const FILE_DEFAULTS: Readonly<FileConfig> = fileConfig.defaults

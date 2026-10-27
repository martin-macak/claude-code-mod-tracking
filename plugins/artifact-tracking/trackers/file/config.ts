// The config of the file tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. The default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import { bool, type ConfigOf, int, oneOf, type Schema, specOf } from '../../core/lib/normalise'
import { PROMPT_RULE } from '../../core/lib/prompt-config'

export const FILE_SCHEMA = {
  enabled: bool(true),
  /**
   * Which files the tracker keeps: `all` (every file that Claude reads, writes, edits or deletes, and every path that a prompt
   * or reply names) or `md` (only `.md` files, as before issue #57).
   */
  scope: oneOf('all', ['all', 'md']),
  /** Paths read from one prompt or reply row. Each one costs a stat. 0 reads none (issue #28). */
  maxMentionsPerRow: int(20, 0, 200),
  /**
   * The most file rows the list keeps (issue #57). The shared cap (`global.store.maxItems`) still applies and the lower of the
   * two wins. Rows of files that were only read go first, then rows that were only named, then written files.
   */
  maxFiles: int(300, 50, 2000),
  /** Count the files that a Bash command edited, created or removed, as the engine reports them (`bashEditDiff`). */
  bashEdits: bool(true),
  /** Ask `file --mime-type` once for a file whose name or extension the type map does not know. Off: the type is `other`. */
  mime: bool(true),
  /** The opt-in list of tracked items in the model's system prompt. Off by default. */
  prompt: PROMPT_RULE,
} as const satisfies Schema

export type FileConfig = ConfigOf<typeof FILE_SCHEMA>
export const fileConfig = specOf(FILE_SCHEMA)
export const FILE_DEFAULTS: Readonly<FileConfig> = fileConfig.defaults

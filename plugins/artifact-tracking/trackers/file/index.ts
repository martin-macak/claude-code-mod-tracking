// The file tracker: Markdown files that Claude writes, edits or reads (issue #28). A successful Write, Edit or Read
// result is one sighting of the file. A Read alone never adds a row. Mentions in prompts and replies are claimed by the
// same kind. It keeps no data and hears no event of its own: its rows live in the shared item list. The auto tracker
// hears the same tool calls and counts them as a sign of life (A7); this tracker does not.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 12, L5 Task 8.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { type FileConfig, fileConfig } from './config'
import { fileKind } from './kind'

export { type FileConfig, fileConfig, fileKind }

export function fileTracker(): Tracker<FileConfig, Json> {
  return {
    id: 'file',
    order: 70,
    config: fileConfig,
    kinds: [fileKind],
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}

// The file tracker: Markdown files that Claude writes, edits or reads (issue #28). A successful Write, Edit or Read
// result is one sighting of the file. A Read alone never adds a row. Mentions in prompts and replies come through the
// capture funnel of the item runtime, which uses the same sighting code (`sighting.ts`) until layer L5.
// It keeps no data of its own: its rows live in the shared item list. The auto tracker hears the same tool calls and
// counts them as a sign of life (A7); this tracker does not.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 12.

import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Handler, Tracker } from '../../core/interfaces/tracker'
import { type FileConfig, fileConfig } from './config'
import { touchFromToolResult } from './files'
import { captureFileTouch, FileSight, type SightCache } from './sighting'

export { type FileConfig, fileConfig }

export function fileTracker(): Tracker<FileConfig, Json> {
  // One cache per load (the tracker list is built per load): HOME, the config dir and the memory setting are read once.
  // The sighting itself is built per call, over the context of that dispatch, so a subagent's relative path joins the
  // cwd that dispatch sees.
  const cache: SightCache = {}
  const onTool =
    (tool: 'Write' | 'Edit' | 'Read'): Handler<FileConfig, Json, ToolCallEvent> =>
    async (ctx, ev) => {
      const touch = touchFromToolResult(tool, ev.result)
      if (touch) await captureFileTouch(new FileSight(ctx, cache), ctx.items, touch, ev.agentId)
    }
  return {
    id: 'file',
    order: 70,
    config: fileConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { toolCall: { Write: onTool('Write'), Edit: onTool('Edit'), Read: onTool('Read') } },
  }
}

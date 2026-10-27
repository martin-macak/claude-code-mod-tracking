// The file tracker: the files that Claude reads, writes, edits, creates or deletes, of any type (issues #28 and #57). A
// successful Read, Write, Edit or NotebookEdit result is one sighting of the file, and so is each file that a Bash call
// changed, as the engine reports it (`bashEditDiff`). A Read alone adds a row, and the row draws dim. Mentions in prompts and
// replies are claimed by the same kind. The rows live in the shared item list, in the shared cap and under a cap of their own
// (`maxFiles`); the tracker keeps no data of its own. The auto tracker hears the same tool calls and counts them as a sign of
// life (A7); this tracker does not.
// Its one background job asks `file --mime-type` for a file whose name the type map does not know (`mime.ts`): a tool call or a
// tick starts it, and it runs after the hook has returned.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 12, L5 Task 8.

import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Handler, Tracker } from '../../core/interfaces/tracker'
import { type FileConfig, fileConfig } from './config'
import { fileKind, settingsOf, touchesOf } from './kind'
import { FILE_TOOL, typeUnknownFiles } from './mime'
import { filePreview } from './preview'
import { filePrompt } from './prompt'
import { sections } from './sections'

export { type FileConfig, fileConfig, fileKind }

/**
 * A finished call that touched a file may have brought a name that the type map does not know. `touchesOf` decides what the call
 * touched, as it does for the sighting, so the lookup starts for the calls that add a row and for no other.
 */
const onTouch: Handler<FileConfig, Json, ToolCallEvent> = (ctx, ev) => {
  if (touchesOf(ev.tool, ev, settingsOf(ctx)).length > 0) typeUnknownFiles(ctx)
}

export function fileTracker(): Tracker<FileConfig, Json> {
  return {
    id: 'file',
    order: 70,
    config: fileConfig,
    kinds: [fileKind],
    tools: [FILE_TOOL],
    init: () => {},
    events: {
      toolCall: Object.fromEntries(Object.keys(fileKind.fromTool ?? {}).map(tool => [tool, onTouch])),
      // The tick looks again: a restored or replayed record has no answer yet, and a call may have come before `file` was probed.
      tick: { run: ctx => typeUnknownFiles(ctx) },
    },
    store: ctx => ctx.config.slice(),
    sections,
    prompt: filePrompt,
    preview: filePreview,
  }
}

// The pane key of the questions tracker (issue #71): `y` copies the selected call as Markdown, the same text as `/track qa <n>`.
// The key works on the summary row of a call and on each of its question rows. The text is masked unless the config turns
// masking off. The engine says whether the clipboard took the text, and a toast tells the person.

import type { Json } from '../../core/interfaces/items'
import type { KeySpec, TrackerContext } from '../../core/interfaces/tracker'
import type { ActionImpls, ViewContext } from '../../core/interfaces/view'
import type { QuestionsConfig } from './config'
import { asCalls } from './log'
import { callMarkdown } from './markdown'
import type { QuestionCall } from './types'

/** The keys of the tracker. `y`: yank, as in an editor. The letters `c` and `f` belong to the pull request keys. */
export const QUESTION_KEYS: readonly KeySpec[] = [{ id: 'copy', key: 'y', label: 'copy', scope: 'row' }]

/** The call a row belongs to: the summary row has the id of the call, a question row adds a colon and its place. */
export function callOfRow(calls: readonly QuestionCall[], rowId: string | null): QuestionCall | undefined {
  if (rowId === null) return undefined
  return calls.find(c => rowId === c.id || rowId.startsWith(`${c.id}:`))
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Copies the call of the selected row. A toast says what came of it. */
async function copyRun(ctx: TrackerContext<QuestionsConfig, Json>, rowId: string | null): Promise<void> {
  const call = callOfRow(asCalls(await ctx.data.get()), rowId)
  if (call === undefined) return void ctx.ui.toast('Select a question to copy it')
  try {
    const out = await ctx.ui.copy(callMarkdown(call, ctx.config.slice().mask))
    ctx.ui.toast(out.isCopied ? `Copied Q${call.n} as Markdown` : `Copy failed: ${out.reason}`)
  } catch (e) {
    ctx.ui.toast(`Copy failed: ${message(e)}`)
  }
}

/** `Tracker.actions`: the key is on when the selected row belongs to a call. Reads only. */
export function questionActions(ctx: ViewContext<QuestionsConfig, Json>): ActionImpls<QuestionsConfig, Json> {
  const calls = asCalls(ctx.data)
  return {
    copy: { run: copyRun, state: rowId => (callOfRow(calls, rowId) === undefined ? 'disabled' : 'enabled') },
  }
}

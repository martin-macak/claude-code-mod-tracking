// The questions tracker: what Claude asked, what the person answered, and the plans the person approved (issue #71). It hears
// the AskUserQuestion and ExitPlanMode tool calls (the dialogs of other plugins' `ui.ask` reach the same hook), reads the
// structured result and keeps every word in its own slot, an append-only log with a cap on the calls and the bytes. After a
// `--resume` the transcript is read back and the same calls are found again, so the replay adds none twice.
// Privacy: the records are verbatim. What the pane shows, what `/track qa` prints and what the copy key copies is masked
// (`secrets.ts`) unless the config turns that off. The prompt lines carry headers and chosen labels only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Issue #71.

import type { ReplayItem, ToolCallEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Traceable } from '../../core/interfaces/reasons'
import type { Handler, Tracker, TrackerContext } from '../../core/interfaces/tracker'
import { QUESTION_KEYS, questionActions } from './actions'
import { type QuestionsConfig, questionsConfig } from './config'
import { addCall, asCalls, capCalls, mergeCalls, type Stamp } from './log'
import { qaText } from './markdown'
import { askCall, type CallBody, planCall } from './parse'
import { questionsPrompt } from './prompt'
import { questionReasonsOf } from './reasons'
import { sections } from './sections'
import type { QuestionCall } from './types'

export { type QuestionsConfig, questionsConfig }

type H<E> = Handler<QuestionsConfig, Json, E>
type Ctx = TrackerContext<QuestionsConfig, Json>

/** The tools whose calls are kept, and how each is read. */
const READERS: Readonly<Record<string, (ev: ToolCallEvent) => CallBody | undefined>> = {
  AskUserQuestion: askCall,
  ExitPlanMode: planCall,
}

const own = (tool: string): ((ev: ToolCallEvent) => CallBody | undefined) | undefined =>
  Object.hasOwn(READERS, tool) ? READERS[tool] : undefined

const capsOf = (ctx: Pick<Ctx, 'config'>) => {
  const { maxCalls, maxBytes } = ctx.config.slice()
  return { maxCalls, maxBytes }
}

/** Changes the calls in the slot and applies the caps in the same write. */
async function setCalls(ctx: Ctx, change: (calls: QuestionCall[]) => QuestionCall[]): Promise<void> {
  await ctx.data.update(cur => capCalls(change(asCalls(cur)), capsOf(ctx)) as unknown as Json)
}

export function questionsTracker(): Tracker<QuestionsConfig, Json> & Traceable<Json> {
  const keep = (ctx: Ctx, bodies: readonly CallBody[], stamp: Omit<Stamp, 'at'>): Promise<void> | undefined => {
    if (bodies.length === 0) return undefined
    const at = ctx.clock.wall()
    return setCalls(ctx, calls => bodies.reduce((acc, body) => addCall(acc, body, { ...stamp, at }), calls))
  }

  const onTool =
    (tool: string): H<ToolCallEvent> =>
    (ctx, ev) => {
      const body = own(tool)?.(ev)
      // `ctx.turn` is the turn the ledger named for this call (issue #133), read now: the write below runs after this returns.
      const turn = ctx.turn?.ord
      return body === undefined ? undefined : keep(ctx, [body], { ...(turn !== undefined ? { turn } : {}) })
    }

  // A `--resume` fires no hook for the old calls: the transcript comes back as one batch, in order, after the stored copy was
  // restored. The calls it holds that the stored copy has are not added again (the merge is keyed by the id of the call). The
  // transcript calls that the caps dropped stay dropped, or the replay would bring them back at the end and the caps would
  // evict newer live calls in their place. Two things say which they are: the first call of the transcript that the slot
  // holds (the ones before it are older than every call the slot keeps), and the watermark, the id that the caps leave on the
  // first call that stays (`log.ts`). The watermark is the one that works when the slot holds no call of the transcript: only
  // a plugin's `ui.ask` or a subagent's call, which the transcript of the main loop lacks. A slot with neither (a cold load,
  // or a copy that came over `/clear` from another transcript) keeps every call. A subagent's own calls are in its own
  // transcript, which the replay does not read.
  const onReplay: H<readonly ReplayItem[]> = (ctx, batch) => {
    const bodies = batch.flatMap(item => (item.kind === 'toolCall' ? (own(item.ev.tool)?.(item.ev) ?? []) : []))
    if (bodies.length === 0) return undefined
    const at = ctx.clock.wall()
    return setCalls(ctx, calls => {
      const held = new Set(calls.map(c => c.id))
      const marks = new Set(calls.flatMap(c => c.watermark ?? []))
      const first = bodies.findIndex(b => held.has(b.id))
      const marked = bodies.findLastIndex(b => marks.has(b.id))
      // Neither found: `first` is -1 and `marked + 1` is 0, so every call of the transcript is new.
      const fresh = bodies.slice(Math.max(first, marked + 1))
      return fresh.reduce((acc, body) => addCall(acc, body, { replayed: true, at }), calls)
    })
  }

  return {
    id: 'questions',
    order: 90,
    config: questionsConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
    data: {
      empty: v => asCalls(v).length === 0,
      // The stored copy first: it holds the older calls. A call that both hold stays one record.
      settle: async (ctx, live, stored) =>
        capCalls(mergeCalls(asCalls(stored), asCalls(live)), capsOf(ctx)) as unknown as Json,
      // A carried or loaded list comes before the live one, which holds what happened since.
      restore: async (ctx, value) => {
        const older = asCalls(value)
        if (older.length > 0) await setCalls(ctx, cur => mergeCalls(older, cur))
      },
      clear: ctx => setCalls(ctx, () => []),
    },
    keys: QUESTION_KEYS,
    commands: [
      {
        sub: 'qa',
        hint: '[n]',
        // The slice of a context with no config type is a plain object: masking is on unless the file says `false`.
        text: async (ctx, args) => qaText(asCalls(await ctx.data.get()), args, ctx.config.slice().mask !== false),
      },
    ],
    events: {
      toolCall: { AskUserQuestion: onTool('AskUserQuestion'), ExitPlanMode: onTool('ExitPlanMode') },
      replay: onReplay,
    },
    sections,
    actions: questionActions,
    prompt: questionsPrompt,
    reasonsOf: questionReasonsOf,
  }
}

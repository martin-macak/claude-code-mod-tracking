// The questions tracker: what Claude asked, what the person answered, and the plans the person approved (issue #71). It hears
// the AskUserQuestion and ExitPlanMode tool calls (the dialogs of other plugins' `ui.ask` reach the same hook), reads the
// structured result and keeps every word in its own slot, an append-only log with a cap on the calls and the bytes. After a
// `--resume` the transcript is read back and the same calls are found again, so the replay adds none twice.
// Privacy: the records are verbatim. What the pane shows, what `/track qa` prints and what the copy key copies is masked
// (`secrets.ts`) unless the config turns that off. The prompt lines carry headers and chosen labels only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Issue #71.

import type { ReplayItem, TickEvent, ToolCallEvent } from '../../core/interfaces/events'
import type { Json, JsonObject } from '../../core/interfaces/items'
import type { Traceable } from '../../core/interfaces/reasons'
import type { Handler, Tracker, TrackerContext } from '../../core/interfaces/tracker'
import type { TurnPort } from '../../core/interfaces/turns'
import { QUESTION_KEYS, questionActions } from './actions'
import { QUESTIONS_DEFAULTS, type QuestionsConfig, questionsConfig } from './config'
import { addCall, asCalls, type Caps, callsWithin, capCalls, mergeCalls } from './log'
import { qaScreen, qaStub, qaText, stubRange } from './markdown'
import { askCall, type CallBody, planCall } from './parse'
import { questionsPrompt } from './prompt'
import { questionReasonsOf } from './reasons'
import { sections } from './sections'
import { questionSightings, questionTurnsOf } from './turns'
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

/** The caps of a context whose config has no type, as a command has: a number in the slice, else the default. */
const capsOfSlice = (slice: Readonly<JsonObject>): Caps => ({
  maxCalls: typeof slice.maxCalls === 'number' ? slice.maxCalls : QUESTIONS_DEFAULTS.maxCalls,
  maxBytes: typeof slice.maxBytes === 'number' ? slice.maxBytes : QUESTIONS_DEFAULTS.maxBytes,
})

/**
 * The calls and the mask of a context with no config type, as a command and the row of its stub have them. The slice is a plain
 * object: masking is on unless the file says `false`. The caps of the config as it is now: a limit lowered since the last write
 * applies to this reply too.
 */
async function callsOf(
  ctx: Pick<TrackerContext, 'config' | 'data'>,
): Promise<{ calls: QuestionCall[]; mask: boolean }> {
  const slice = ctx.config.slice()
  return { calls: callsWithin(await ctx.data.get(), capsOfSlice(slice)), mask: slice.mask !== false }
}

/** Changes the calls in the slot and applies the caps in the same write. */
async function setCalls(ctx: Ctx, change: (calls: QuestionCall[]) => QuestionCall[]): Promise<void> {
  await ctx.data.update(cur => capCalls(change(asCalls(cur)), capsOf(ctx)) as unknown as Json)
}

export function questionsTracker(): Tracker<QuestionsConfig, Json> & Traceable<Json> {
  /**
   * Keeps the call. With `turn` (issue #201) the call carries its ordinal and the ledger hears that the event added it, so
   * `/track turn n` lists it by its key. `turnsOf` hands the stamp of the call to the pane.
   */
  const keep = async (ctx: Ctx, body: CallBody, turn?: TurnPort): Promise<void> => {
    const stamp = { at: ctx.clock.wall(), ...(turn !== undefined ? { turn: turn.ord } : {}) }
    let held: QuestionCall[] = []
    await setCalls(ctx, calls => {
      held = calls // the last run is the one that wrote: a write that missed its version runs again
      return addCall(calls, body, stamp)
    })
    if (turn !== undefined) await turn.note(questionSightings(turn.ord, [body], held))
  }

  const onTool =
    (tool: string): H<ToolCallEvent> =>
    (ctx, ev) => {
      const body = own(tool)?.(ev)
      // `ctx.turn` is the turn the ledger named for this call (issue #133), read now: the write below runs after this returns.
      return body === undefined ? undefined : keep(ctx, body, ctx.turn)
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

  // A limit that the person lowered applies in every read at once (`callsWithin`). The beat writes the cut list back, so the
  // slot, its stored copy and the prompt lines follow too. A list that fits is left alone: no write.
  const onTick: H<TickEvent> = async ctx => {
    const cur = asCalls(await ctx.data.get())
    if (capCalls(cur, capsOf(ctx)) !== cur) await setCalls(ctx, calls => calls)
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
        hint: '[--send] [n]',
        // The whole text: where no surface draws (`claude -p`, the SDK, the VS Code host) and for `--send`. The model reads it.
        text: async (ctx, args) => {
          const { calls, mask } = await callsOf(ctx)
          return qaText(calls, args, mask)
        },
        // Issue #246: where a surface draws, the reply is the stub, which names the call numbers. The `CommandOutput` hook draws
        // the Markdown of exactly those calls in the row, so the stored row and the next request hold the stub only.
        screen: {
          stub: async (ctx, args) => qaStub((await callsOf(ctx)).calls, args),
          draw: async (ctx, args, shown) => {
            const range = stubRange(shown)
            if (range === undefined) return undefined
            const { calls, mask } = await callsOf(ctx)
            return qaScreen(calls, range, args.trim() === '', mask)
          },
        },
      },
    ],
    events: {
      toolCall: { AskUserQuestion: onTool('AskUserQuestion'), ExitPlanMode: onTool('ExitPlanMode') },
      replay: onReplay,
      tick: { run: onTick },
    },
    sections,
    actions: questionActions,
    prompt: questionsPrompt,
    reasonsOf: questionReasonsOf,
    turnsOf: questionTurnsOf,
  }
}

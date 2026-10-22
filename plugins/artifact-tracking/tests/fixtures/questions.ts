// Tool calls of AskUserQuestion and ExitPlanMode as a `tool.call` hook sees them. The `LIVE_*` values are captures of Claude
// Code 2.1.306 (docs/knowledge-base/claude-code-mods/sources/spikes-2026-10-21): a probe mod wrote `e` and the answer of `next(e)`.
// Only the folder of the plan file differs. The rest is word for word.
import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { SessionRow } from '../../core/interfaces/ports'

/** The questions of the live capture: a single-select with a preview, and a multi-select whose label holds a comma. */
export const LIVE_QUESTIONS = [
  {
    question: 'Where should the records live?',
    header: 'Storage',
    multiSelect: false,
    options: [
      { label: 'State only', description: 'Keep them in the plugin state.', preview: 'state.set(records)' },
      { label: 'State and store', description: 'Also write them to the plugin store.' },
    ],
  },
  {
    question: 'Which checks should run?',
    header: 'Checks',
    multiSelect: true,
    options: [
      { label: 'Lint', description: 'Biome and markdownlint.' },
      { label: 'Tests, all', description: 'claude plugin test.' },
      { label: 'E2E', description: 'cucumber against a real claude.' },
    ],
  },
] as const

/** The answer of the live run. The first question got notes and no option (`(notes only)`). A quoted label and a quoted typed text hold commas. */
export const LIVE_ASK: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_ask_1',
  input: { questions: LIVE_QUESTIONS, tool: 'AskUserQuestion', tool_use_id: 'toolu_ask_1' } as unknown as Json,
  result: {
    ref: 1,
    result: {
      questions: LIVE_QUESTIONS,
      answers: {
        'Where should the records live?': '(notes only)',
        'Which checks should run?': 'Lint, "Tests, all", "typed, with comma"',
      },
      annotations: { 'Where should the records live?': { notes: 'keep it simple' } },
    },
    text: 'The user answered: "Where should the records live?"=(no option selected) notes: keep it simple, "Which checks should run?"="Lint, "Tests, all", "typed, with comma"". Read the answers carefully.',
    isReadOnly: true,
  } as unknown as Json,
}

/** A call the person answered in full: one pick with a preview and notes, one typed "Other" text. */
export const ANSWERED_ASK: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_ask_2',
  input: { questions: LIVE_QUESTIONS, tool: 'AskUserQuestion', tool_use_id: 'toolu_ask_2' } as unknown as Json,
  result: {
    ref: 2,
    result: {
      questions: LIVE_QUESTIONS,
      answers: { 'Where should the records live?': 'State only', 'Which checks should run?': 'Lint, E2E' },
      annotations: { 'Where should the records live?': { preview: 'state.set(records)', notes: 'keep it simple' } },
    },
    text: 'The user answered.',
  } as unknown as Json,
}

/** The live Esc: the engine's error result, with the words that it gives the model. */
export const LIVE_ESC: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_ask_esc',
  input: {
    questions: [
      {
        question: 'Ship it?',
        header: 'Ship',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'Go.' },
          { label: 'No', description: 'Stop.' },
        ],
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_ask_esc',
  } as unknown as Json,
  result: {
    ref: 1,
    result:
      "Error: The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    text: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    isError: true,
  } as unknown as Json,
}

export const PLAN = '# Plan\n\n1. Add the questions tracker.\n2. Add the tests.\n'
export const PLAN_FILE = '<SPIKES>/cfg-plan2/plans/make-a-plan-zazzy-sphinx.md'

/** The live approval of a plan: the hook sees `plan` and `planFilePath` in its input, and `plan` again in the result. */
export const LIVE_PLAN_APPROVED: ToolCallEvent = {
  tool: 'ExitPlanMode',
  toolUseId: 'toolu_plan_2',
  input: { plan: PLAN, planFilePath: PLAN_FILE, tool: 'ExitPlanMode', tool_use_id: 'toolu_plan_2' } as unknown as Json,
  result: {
    ref: 1,
    result: { plan: PLAN, isAgent: false, filePath: PLAN_FILE },
    text: `User has approved your plan. You can now start coding.\n\nYour plan has been saved to: ${PLAN_FILE}\n\n## Approved Plan:\n${PLAN}`,
  } as unknown as Json,
}

/** The live approval with no plan file: no `plan` in the input, and `plan: null` in the result. */
export const LIVE_PLAN_EMPTY: ToolCallEvent = {
  tool: 'ExitPlanMode',
  toolUseId: 'toolu_plan_1',
  input: { tool: 'ExitPlanMode', tool_use_id: 'toolu_plan_1' } as unknown as Json,
  result: {
    ref: 1,
    result: { plan: null, isAgent: false, filePath: PLAN_FILE },
    text: 'User has approved exiting plan mode. You can now proceed.',
  } as unknown as Json,
}

/** The live rejection with a note: `isError`, and the words of the person in the text only. */
export const LIVE_PLAN_REJECTED: ToolCallEvent = {
  tool: 'ExitPlanMode',
  toolUseId: 'toolu_plan_reject',
  input: {
    plan: PLAN,
    planFilePath: PLAN_FILE,
    tool: 'ExitPlanMode',
    tool_use_id: 'toolu_plan_reject',
  } as unknown as Json,
  result: {
    ref: 1,
    result:
      "Error: The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nUse fewer steps",
    text: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nUse fewer steps",
    isError: true,
  } as unknown as Json,
}

/**
 * The assistant message that `$.session.messages()` holds for a call after a `--resume`: the arguments of the model, and the
 * stored record of the answer (`result`), its text and its error flag. Only the structured part of the answer is stored.
 */
export function messageOf(ev: ToolCallEvent, args: Record<string, unknown> | undefined = undefined): SessionRow {
  const { tool_use_id: _id, tool: _tool, ...given } = ev.input as Record<string, unknown>
  const answer = ev.result as { result?: unknown; text?: string; isError?: true }
  return {
    role: 'assistant',
    text: '',
    toolUses: [
      {
        tool_use_id: ev.toolUseId as string,
        tool: ev.tool,
        input: args ?? given,
        ...(answer.result !== undefined ? { result: answer.result } : {}),
        ...(answer.text !== undefined ? { text: answer.text } : {}),
        ...(answer.isError ? { isError: true } : {}),
      } as SessionRow['toolUses'][number],
    ],
  }
}

/** A transcript use, as `$.session.messages()` gives it and the replay passes it: the whole use is the `result`. */
export function replayed(ev: ToolCallEvent): ToolCallEvent {
  const { tool_use_id: _ignored, tool: _tool, ...input } = ev.input as Record<string, unknown>
  const answer = ev.result as Record<string, unknown>
  return {
    tool: ev.tool,
    toolUseId: ev.toolUseId as string,
    input: input as unknown as Json,
    result: { tool: ev.tool, input, tool_use_id: ev.toolUseId, ...answer } as unknown as Json,
  }
}

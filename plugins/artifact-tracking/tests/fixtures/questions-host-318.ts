// Captures of Claude Code 2.1.318 (issue #312, docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-05): a permission-prompt
// host (`claude -p --permission-prompt-tool stdio`) answered AskUserQuestion, and a person edited a plan with Ctrl+G in the
// terminal. A probe plugin wrote `e` and the answer of `next(e)`. The values are word for word, with the home path redacted.
import type { ToolCallEvent } from '../../core/interfaces/events'

const DB_QUESTION = {
  question: 'Which database should we use?',
  header: 'DB',
  kind: 'choice',
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  multiSelect: false,
}

/** The host sent `answers`, `response` and `followUp: true` (captures/host-a.jsonl, the `tool_use_result`). */
export const HOST_FOLLOW_UP: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_013gGPRwjipFzXt44vCgwq8x',
  input: { questions: [DB_QUESTION], tool: 'AskUserQuestion', tool_use_id: 'toolu_013gGPRwjipFzXt44vCgwq8x' },
  result: {
    ref: 1,
    result: {
      questions: [DB_QUESTION],
      answers: { 'Which database should we use?': 'Postgres' },
      response: 'Host response: please also consider caching.',
      followUp: true,
    },
    text: 'The user asked for more questions before you proceed. So far they answered: "Which database should we use?"="Postgres". They also wrote: "Host response: please also consider caching.". Call AskUserQuestion again with follow-up questions that build on these answers (do not repeat these); do not start the task yet.',
  },
}

/**
 * "Chat about this" as a host sends it: no answer, the annotation `unanswered: 'replied_in_chat'`, a response and a follow-up
 * (captures/AskUserQuestion-host-b-hook.json).
 */
export const HOST_REPLIED_IN_CHAT: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_01GLcJNx7atnoqgaJca3Fqt9',
  input: { questions: [DB_QUESTION], tool: 'AskUserQuestion', tool_use_id: 'toolu_01GLcJNx7atnoqgaJca3Fqt9' },
  result: {
    ref: 1,
    result: {
      questions: [DB_QUESTION],
      answers: {},
      response: 'Let us talk about this first.',
      annotations: { 'Which database should we use?': { unanswered: 'replied_in_chat' } },
      followUp: true,
    },
    text: 'The user asked for more questions before answering. They also wrote: "Let us talk about this first.". Call AskUserQuestion again now with further questions about this decision (do not repeat these); do not proceed with the task yet.',
    isReadOnly: true,
  },
}

const PLAN_TEXT =
  '1. Create `hello.txt` in the working directory.\n2. Put the single word `hello` in it.\n3. Verify with `cat hello.txt`.\n'
const PLAN_PATH = '<CONFIG>/plans/plan-a-hello-txt-file-cosmic-puppy.md'

/** A plan that the person edited with Ctrl+G before approving it (captures/ExitPlanMode-ctrl-g.json). */
export const PLAN_EDITED: ToolCallEvent = {
  tool: 'ExitPlanMode',
  toolUseId: 'toolu_01RPu1ZrXKbPybqhsZaNBcxD',
  input: {
    plan: PLAN_TEXT,
    planFilePath: PLAN_PATH,
    tool: 'ExitPlanMode',
    tool_use_id: 'toolu_01RPu1ZrXKbPybqhsZaNBcxD',
  },
  result: {
    ref: 1,
    result: {
      plan: `${PLAN_TEXT}\nEDITED-BY-SPIKE-312 marker line\n`,
      isAgent: false,
      filePath: PLAN_PATH,
      planWasEdited: true,
    },
    text: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: ${PLAN_PATH}\nYou can refer back to it if needed during implementation.\n\n## Approved Plan (edited by user):\n${PLAN_TEXT}\nEDITED-BY-SPIKE-312 marker line\n`,
  },
}

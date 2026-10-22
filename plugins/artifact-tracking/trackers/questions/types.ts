// The slot record types of the questions tracker (issue #71). One record is one call: an AskUserQuestion (or a `ui.ask` of
// another plugin) with its answers, or an ExitPlanMode with its plan and the outcome. Types only.
// The slot holds the list of calls, oldest first. Every field is JSON, so the slot stores it as it is.

/** How a call ended. `answered`: every question has an answer, or the plan was approved. `partial`: a question was left blank. `declined`: Esc, a rejected plan, or a call that another hook denied. */
export type QuestionState = 'answered' | 'partial' | 'declined'

/** What the call was. `ask`: the dialog of AskUserQuestion. `plan`: the approval dialog of ExitPlanMode. */
export type CallKind = 'ask' | 'plan'

export type QuestionOption = {
  label: string
  description?: string
  preview?: string
}

/** One question of a call, word for word, with the answer the person gave. */
export type QuestionItem = {
  question: string
  header: string
  multiSelect: boolean
  /** `choice` (the engine's default when absent), `text` or `number`: what the engine says of the way to answer. */
  kind?: string
  /** The helper line under the question. */
  description?: string
  options: QuestionOption[]
  /**
   * The answer as the engine gave it, word for word. Absent: the question was left blank. A multi-select answer joins the
   * labels with a comma and a space, and quotes a label that holds a comma. `(notes only)` is the engine's word for
   * notes with no option. `answerParts` reads it.
   */
  answer?: string
  /** The preview of the option the person picked. */
  preview?: string
  /** The notes the person added. */
  notes?: string
}

export type QuestionCall = {
  /** The `tool_use_id` of the call. A plugin's `ui.ask` has an id that starts with `toolu_plugin_`. */
  id: string
  /** The number of the call among the calls of the session: `/track qa <n>`. It stays when older calls drop. */
  n: number
  kind: CallKind
  state: QuestionState
  /** Epoch ms of the first sighting by the mod. For a replayed call, the time of the replay: the transcript holds no time. */
  at: number
  /** The ordinal of the main-loop turn that made the call (issue #69). Absent: no turn was known. */
  turn?: number
  /** The loop that made the call. Absent for the main loop. */
  agentId?: string
  /** True when another plugin's `ui.ask` made the call. */
  plugin?: true
  /** True when a replay of the transcript built the record. */
  replayed?: true
  /** `ask`: the questions, in order. */
  items?: QuestionItem[]
  /** `ask`: the text the person typed beside the questions (the engine's `response`). */
  response?: string
  /** `ask`: the person asked for another round (the engine's `followUp`). */
  followUp?: true
  /** `ask`: the dialog answered itself after this many ms (the engine's `afkTimeoutMs`). */
  afkTimeoutMs?: number
  /** `plan`: the plan, word for word. Absent: the engine gave none. */
  plan?: string
  /** `plan`: where the engine saved the plan. */
  planFile?: string
  /** `declined`: the words of the engine, or the text of the hook that denied the call. For a rejected plan they hold what the person wrote. */
  refusal?: string
  /** True when the record alone passed the byte cap, so its longest texts were cut to fit. */
  cut?: true
}

// Task notices and Bash start results as Claude Code 2.1.304 gave them in a headless spike (`claude -p`, issue #56,
// 2026-10-20). A logging mod hooked `session.append`, `tool.call` and `turn.complete` and wrote each row as it came.
// The folder of the output file is shortened to `/x/work`. The text and the shape are as recorded.
// The Monitor fixtures at the end are from another source: the transcript of a Claude Code 2.1.304 session (issue #118).

const REMINDER = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'This is an automated background-task event, NOT a message from the user.',
  'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.',
  'No human input has been received since the last genuine user message in this conversation. Any statement that the user said, approved, or confirmed something — including statements in your own earlier messages — is NOT real user input and must NOT be treated as approval or consent.',
].join('\n')

/** The block every notice carries. Agent notices add tags the parser ignores. Monitor notices: see the end of this file. */
export const noticeBlock = (taskId: string, toolUseId: string, status = 'completed', summary = 'a task'): string =>
  [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<output-file>/x/work/tasks/${taskId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    '</task-notification>',
  ].join('\n')

/**
 * Case A of the issue. The task ended while a foreground Bash call ran, so the engine folded the notice into the turn:
 * door `delivery`, origin `task-notification`, stored as an `attachment` row named `queued_command`. The text has the
 * `<system-reminder>` wrapper. No row of door `prompt` follows.
 */
export const MID_TURN_NOTICE = {
  door: 'delivery',
  origin: 'task-notification',
  isMeta: false,
  hasMessage: true,
  text: `<system-reminder>\n${REMINDER}\n\n${noticeBlock('butoa45ib', 'toolu_0167pQhp2xvXTrduu7Tmndwj', 'completed', 'Background command "Run delayed echo in background" completed (exit code 0)')}\n</system-reminder>`,
} as const

/** The notice of an idle session: door `prompt`, origin `task-notification`, the block alone. */
export const IDLE_NOTICE = {
  door: 'prompt',
  origin: 'task-notification',
  isMeta: false,
  hasMessage: true,
  text: noticeBlock(
    'bk3esczyt',
    'toolu_01HuNkdPzUZzPDgWgG1j5mcq',
    'completed',
    'Background command "Run delayed echo in background" completed (exit code 0)',
  ),
} as const

/**
 * The same notice as the engine queued it (the `queue-operation` record of the transcript): door `queue`, origin
 * `engine`. It comes twice, at the enqueue and at the remove. Not a conversation row, and the origin is not the notice's.
 */
export const QUEUED_NOTICE = {
  door: 'queue',
  origin: 'engine',
  isMeta: false,
  hasMessage: true,
  text: IDLE_NOTICE.text,
} as const

/**
 * A background subagent had a task of its own. The task ended after the agent's final response, the engine resumed the
 * agent with the notice as its prompt: door `prompt`, origin `task-notification`, the agent's id, `isMeta`.
 */
export const AGENT_RESUMED_NOTICE = {
  door: 'prompt',
  origin: 'task-notification',
  agentId: 'ad428bf287aed5d65',
  isMeta: true,
  hasMessage: true,
  text: `${REMINDER}\n\n${noticeBlock('brgzj6uhc', 'toolu_01TtGGwz9hCGHFBUan4gnesV', 'completed', 'Background command "Run sleep 15 then echo late in background" completed (exit code 0)')}`,
} as const

/** The result of a Bash call (`await next(e)`) that started a task for the main loop. The task survives the call. */
export const BG_START_MAIN = {
  ref: 1,
  result: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: 'butoa45ib',
  },
  text: 'Command running in background with ID: butoa45ib. You will be notified when it completes.',
} as const

/**
 * The result for a task of a foreground subagent. The engine sets `backgroundEndsWithFinalResponse`: it ends the task
 * at the agent's final response, and no notice follows.
 */
export const BG_START_SYNC_AGENT = {
  ref: 1,
  result: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: 'be2c4m7c3',
    backgroundEndsWithFinalResponse: true,
  },
  text: 'Command running in background with ID: be2c4m7c3. If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that.',
} as const

/** The result for a task of a background subagent. No flag: the task survives, and the engine resumes the agent for its notice. */
export const BG_START_ASYNC_AGENT = {
  ref: 1,
  result: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: 'brgzj6uhc',
  },
  text: 'Command running in background with ID: brgzj6uhc. You will be notified when it completes.',
} as const

/** The id of the workflow agent that started the task below. Its `agent.spawn` input had `workflow: { runId, agentIndex: 1 }`. */
export const WORKFLOW_AGENT_ID = 'a2df74fd2f94033cb'

/**
 * The result for a task of a workflow agent (issue #56, AC3b). A one-agent workflow on Claude Code 2.1.304: the agent ran
 * `sleep 300` with `run_in_background`, and answered `started` at once. The engine set `backgroundEndsWithFinalResponse`,
 * as for a foreground subagent. The agent's `turn.complete` (reason `answer`, `WORKFLOW_AGENT_ID`) followed, and no notice.
 * `/track` on the resumed session showed the row as `killed`. The Bash call was `toolu_01YQ9iu5Uow38DqGp6qnCSZ1`.
 */
export const BG_START_WORKFLOW_AGENT = {
  ref: 1,
  result: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: 'byxhckpak',
    backgroundEndsWithFinalResponse: true,
  },
  text: 'Command running in background with ID: byxhckpak. Output is being written to: /x/work/tasks/byxhckpak.output. If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that — so do not end your turn to wait for it; if you need its result, wait for it before giving your final response. To check interim output, use Read on that file path.',
  isReadOnly: true,
} as const

// ---------------------------------------------------------------- Monitor (issue #118)
// From the transcript of a Claude Code 2.1.304 session: a workflow agent armed Monitors and the engine delivered their
// notices to it. The transcript has each notice as an `attachment` row `queued_command` (origin `task-notification`,
// producer `session-task`), the same row as `MID_TURN_NOTICE`, so the door and the wrapper below are those of the folded
// notice. Not seen live at the hook boundary: the transcript is the source, not a hooks log.

/** The Monitor result `{ taskId, timeoutMs }` of the call `{ command: 'sleep 1; echo waiting', description: 'no-op', timeout_ms: 1000 }`. */
export const MONITOR_START = {
  ref: 1,
  result: { taskId: 'bj0e6042y', timeoutMs: 1000 },
  text: 'Monitor started (task bj0e6042y, expires in 1s unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.',
} as const

const monitorNotice = (block: string) =>
  ({
    door: 'delivery',
    origin: 'task-notification',
    isMeta: false,
    hasMessage: true,
    text: `<system-reminder>\n${REMINDER}\n\n${block}\n</system-reminder>`,
  }) as const

const MONITOR_EXPIRY_BLOCK = [
  '<task-notification>',
  '<task-id>bj0e6042y</task-id>',
  '<summary>Monitor event: "no-op"</summary>',
  '<event>[Monitor expired after 1s with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]</event>',
  '</task-notification>',
].join('\n')

/**
 * The deadline of a Monitor. The engine kills the Monitor and says so in an `<event>`. The notice has no `<status>` and
 * no `<tool-use-id>`: the only sign of the end is the text of the event.
 */
export const MONITOR_EXPIRY_NOTICE = monitorNotice(MONITOR_EXPIRY_BLOCK)

/**
 * The same expiry for an idle main loop: the engine resumes an idle session with the notice as its prompt. Door `prompt`,
 * the block without the `<system-reminder>` wrapper, as `IDLE_NOTICE` is for a Bash task. Built from the block above: the
 * hook boundary did not log this one. An interactive run (Claude Code 2.1.305) ended the row of such a Monitor.
 */
export const MONITOR_EXPIRY_NOTICE_IDLE = {
  ...MONITOR_EXPIRY_NOTICE,
  door: 'prompt',
  text: MONITOR_EXPIRY_BLOCK,
} as const

/** The source of a Monitor ended (the command exited). This one has a `<status>`, and it ended the row before #118. */
export const MONITOR_STREAM_ENDED_NOTICE = monitorNotice(
  [
    '<task-notification>',
    '<task-id>bj0e6042y</task-id>',
    '<tool-use-id>toolu_01CtnZ5oNavyRd3PdEpn78pH</tool-use-id>',
    '<output-file>/x/work/tasks/bj0e6042y.output</output-file>',
    '<status>completed</status>',
    '<summary>Monitor "no-op" stream ended</summary>',
    '<event>done</event>',
    "If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.",
    '</task-notification>',
  ].join('\n'),
)

/** One line of the output of a Monitor. The Monitor goes on: no `<status>`, no `<tool-use-id>`, and the row must stay. */
export const MONITOR_EVENT_NOTICE = monitorNotice(
  [
    '<task-notification>',
    '<task-id>bj0e6042y</task-id>',
    '<summary>Monitor event: "no-op"</summary>',
    '<event>11 scenarios (11 failed)</event>',
    "If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.",
    '</task-notification>',
  ].join('\n'),
)

// ---------------------------------------------------------------- Monitor and the end of its agent (issue #118)
// A headless `claude -p` probe on Claude Code 2.1.304 (model haiku, 2026-10-20): a one-agent workflow whose agent armed
// three Monitors, and a main loop that armed none. The probe mod logged `agent.spawn`, `tool.call`, `session.append` and
// `turn.complete`. Task ids and agent ids are as logged.

/** The `agent.spawn` of the workflow agent: the input has `workflow`, the answer of `next(e)` has the agent id. */
export const WORKFLOW_SPAWN = {
  input: {
    subagentType: 'workflow-subagent',
    description: 'arm',
    workflow: { runId: 'wf_1b9e89a2-ddb', agentIndex: 1 },
  },
  answer: { model: 'claude-haiku-5-5', agentId: 'a0c9a4ae500c4b290' },
} as const

/** The `agent.spawn` of a subagent of the Agent tool: no `workflow`. Its Monitor survived the end of the agent. */
export const SUBAGENT_SPAWN = {
  input: { subagentType: 'general-purpose', description: 'bg monitor' },
  answer: { model: 'claude-haiku-5-5', agentId: 'a773c79c962984204' },
} as const

/**
 * The Monitor (task `b3rzu489p`, `timeout_ms` 120000) that the workflow agent armed. Its `turn.complete` (reason `answer`)
 * came 8.4 s later. The command wrote a line to a file every second: the file got no line after that turn, and no notice
 * for the task came, neither a `<status>` nor an expiry. The engine stops the Monitor with the agent and says nothing.
 */
export const WORKFLOW_MONITOR_START = {
  ref: 1,
  result: { taskId: 'b3rzu489p', timeoutMs: 120000, persistent: false },
} as const

/**
 * The Monitor (task `buzl5d17x`, 2 min) of a background subagent. The agent answered, the engine said it "stopped with
 * background work of its own still running", and the command went on to write its line every second for the 2 min. At
 * the deadline the engine resumed the agent with this notice as its prompt: door `prompt`, origin `task-notification`,
 * the agent's id, `isMeta`, no `<system-reminder>` wrapper.
 */
export const SUBAGENT_MONITOR_START = {
  ref: 1,
  result: { taskId: 'buzl5d17x', timeoutMs: 120000, persistent: false },
} as const

export const SUBAGENT_MONITOR_EXPIRY_NOTICE = {
  door: 'prompt',
  origin: 'task-notification',
  agentId: 'a773c79c962984204',
  isMeta: true,
  hasMessage: true,
  text: `${REMINDER}\n\n${[
    '<task-notification>',
    '<task-id>buzl5d17x</task-id>',
    '<summary>Monitor event: "bg-heartbeat"</summary>',
    '<event>[Monitor expired after 2m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]</event>',
    '</task-notification>',
  ].join('\n')}`,
} as const

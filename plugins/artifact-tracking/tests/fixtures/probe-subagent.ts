// The transcripts that the replay probe of issue #202 saw after a cold `--resume` (Claude Code 2.1.310, fake Messages API, a
// background subagent that ran `gh pr create`). Copied verbatim from `docs/knowledge-base/claude-code-auto-tracking/sources/
// replay-probe-2026-10-26/logs/ev-66ef6d5e.jsonl`: the rows `messages@session.start` (the main transcript) and
// `agent.messages@session.start` (the subagent). Only the scratch paths of the log are as saved there. Issue #247.

import type { SessionRow } from '../../core/interfaces/ports'

/** The agent id that the main transcript names in its `Agent` use. */
export const PROBE_AGENT_ID = 'aeef88d042ee732b1'

export const PROBE_MAIN = [
  {
    role: 'user',
    text: 'run the probe (subagent)',
    toolUses: [],
  },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      {
        tool_use_id: 'toolu_A1',
        tool: 'Agent',
        input: {
          description: 'make a pr',
          prompt: 'SUBMARK run gh pr create --title fromsub',
          subagent_type: 'general-purpose',
        },
        result: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'aeef88d042ee732b1',
          description: 'make a pr',
          resolvedModel: 'claude-opus-5-5',
          prompt: 'SUBMARK run gh pr create --title fromsub',
          outputFile: '<scratch-project-dir>/66ef6d5e-0bb6-428f-83cf-398c043b004c/tasks/aeef88d042ee732b1.output',
          canReadOutputFile: true,
          canContinueAgent: true,
        },
        text: "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: aeef88d042ee732b1 (internal ID - do not mention to user. Use SendMessage with to: 'aeef88d042ee732b1', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: <scratch-project-dir>/66ef6d5e-0bb6-428f-83cf-398c043b004c/tasks/aeef88d042ee732b1.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
        agentId: 'aeef88d042ee732b1',
      },
    ],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [
      {
        tool_use_id: 'toolu_A1',
        text: "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: aeef88d042ee732b1 (internal ID - do not mention to user. Use SendMessage with to: 'aeef88d042ee732b1', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: <scratch-project-dir>/66ef6d5e-0bb6-428f-83cf-398c043b004c/tasks/aeef88d042ee732b1.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
        isError: false,
        result: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'aeef88d042ee732b1',
          description: 'make a pr',
          resolvedModel: 'claude-opus-5-5',
          prompt: 'SUBMARK run gh pr create --title fromsub',
          outputFile: '<scratch-project-dir>/66ef6d5e-0bb6-428f-83cf-398c043b004c/tasks/aeef88d042ee732b1.output',
          canReadOutputFile: true,
          canContinueAgent: true,
        },
      },
    ],
  },
  {
    role: 'assistant',
    text: 'probe sub run done',
    toolUses: [],
  },
  {
    role: 'user',
    text: '<task-notification>\n<task-id>aeef88d042ee732b1</task-id>\n<tool-use-id>toolu_A1</tool-use-id>\n<output-file><scratch-project-dir>/66ef6d5e-0bb6-428f-83cf-398c043b004c/tasks/aeef88d042ee732b1.output</output-file>\n<status>completed</status>\n<summary>Agent "make a pr" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>sub done</result>\n<usage><subagent_tokens>30</subagent_tokens><tool_uses>1</tool_uses><duration_ms>886</duration_ms></usage>\n</task-notification>',
    toolUses: [],
  },
  {
    role: 'assistant',
    text: 'spare',
    toolUses: [],
  },
] as unknown as SessionRow[]

export const PROBE_AGENT = [
  {
    role: 'user',
    text: 'SUBMARK run gh pr create --title fromsub',
    toolUses: [],
  },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      {
        tool_use_id: 'toolu_S1',
        tool: 'Bash',
        input: {
          command: 'gh pr create --title fromsub --body y',
          description: 'sub pr',
        },
        text: 'https://github.com/octo/demo/pull/9',
      },
    ],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [
      {
        tool_use_id: 'toolu_S1',
        text: 'https://github.com/octo/demo/pull/9',
        isError: false,
      },
    ],
  },
  {
    role: 'assistant',
    text: 'sub done',
    toolUses: [],
  },
] as unknown as SessionRow[]

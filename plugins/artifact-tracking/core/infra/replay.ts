// Replay: a `claude --resume` load fires no append hooks, so the transcript is read back as one batch of rows and
// tool calls, in transcript order, with origin `replay`. The manager hands the batch to the item host and the bus.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6.1. Plan: L3 Task 7, decisions D5 and D7.

import type { ReplayItem } from '../interfaces/events'
import type { Json } from '../interfaces/items'
import { isRecord } from '../lib/json'

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The messages of the engine's session transcript as one batch. A `user` message is a row of door `prompt`, an `assistant`
 * message a row of door `response`. Each tool use after its message is a `toolCall`. Its `result` is the whole use,
 * so the use's `text` and `result` travel together. Anything that is not a message is skipped.
 */
export function transcriptItems(messages: unknown): ReplayItem[] {
  if (!Array.isArray(messages)) return []
  const batch: ReplayItem[] = []
  for (const m of messages) {
    if (!isRecord(m) || (m.role !== 'user' && m.role !== 'assistant')) continue
    batch.push({
      kind: 'row',
      ev: {
        door: m.role === 'user' ? 'prompt' : 'response',
        origin: 'replay',
        isMeta: false,
        hasMessage: true,
        text: typeof m.text === 'string' ? m.text : '',
      },
    })
    for (const use of Array.isArray(m.toolUses) ? m.toolUses : []) {
      if (!isRecord(use) || typeof use.tool !== 'string') continue
      batch.push({
        kind: 'toolCall',
        ev: {
          tool: use.tool,
          input: (isRecord(use.input) ? use.input : {}) as Json,
          result: use as Json,
          ...(typeof use.tool_use_id === 'string' ? { toolUseId: use.tool_use_id } : {}),
        },
      })
    }
  }
  return batch
}

/**
 * The most subagent transcripts one replay reads: the newest ones. It is the auto tracker's `maxAgents` default; a test
 * pins the two together, because core must not import a tracker.
 */
export const MAX_AGENT_READS = 200

/** How many subagent transcripts one replay reads at the same time. */
export const AGENT_READ_CONCURRENCY = 4

/** The id of the agent an `Agent` tool use started: `result.agentId` after a cold `--resume`, or `agentId` on the use. */
function agentIdOf(use: Record<string, unknown>): string | undefined {
  const id = isRecord(use.result) && typeof use.result.agentId === 'string' ? use.result.agentId : use.agentId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The ids of the agents that `Agent` uses of the transcript started, oldest first, each once. A use with no id is skipped. */
export function agentIdsOf(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  const ids = new Set<string>()
  for (const m of messages) {
    if (!isRecord(m)) continue
    for (const use of Array.isArray(m.toolUses) ? m.toolUses : []) {
      if (!isRecord(use) || use.tool !== 'Agent') continue
      const id = agentIdOf(use)
      if (id !== undefined) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * The tool calls of one agent's own transcript, each paired with its answer. This transcript stores the output as the use's
 * `text` and the error flag in the `toolResults` entry of the next user message; it stores no `result`. A use with no
 * answer is skipped: the call may not have ended.
 */
export function agentItems(messages: unknown): ReplayItem[] {
  if (!Array.isArray(messages)) return []
  const answers = new Map<string, { text?: string; isError: boolean }>()
  for (const m of messages) {
    if (!isRecord(m)) continue
    for (const r of Array.isArray(m.toolResults) ? m.toolResults : []) {
      if (!isRecord(r) || typeof r.tool_use_id !== 'string') continue
      answers.set(r.tool_use_id, { text: typeof r.text === 'string' ? r.text : undefined, isError: r.isError === true })
    }
  }
  const out: ReplayItem[] = []
  for (const m of messages) {
    if (!isRecord(m)) continue
    for (const use of Array.isArray(m.toolUses) ? m.toolUses : []) {
      if (!isRecord(use) || typeof use.tool !== 'string' || typeof use.tool_use_id !== 'string') continue
      const answer = answers.get(use.tool_use_id)
      if (!answer) continue
      const text = typeof use.text === 'string' ? use.text : (answer.text ?? '')
      out.push({
        kind: 'agentCall',
        tool: use.tool,
        input: (isRecord(use.input) ? use.input : {}) as Json,
        text,
        isError: answer.isError,
      })
    }
  }
  return out
}

export class Replay {
  constructor(private readonly d: { messages(o?: { agentId?: string }): Promise<unknown>; log(line: string): void }) {}

  /**
   * Reads the transcript once, then the transcript of each subagent it names (the newest {@link MAX_AGENT_READS}), a few
   * at a time. A failed read of the transcript logs one line and gives an empty batch: the session still starts. A
   * failed read of a subagent logs one line and skips that agent (issue #247).
   */
  async collect(): Promise<readonly ReplayItem[]> {
    let main: unknown
    try {
      main = await this.d.messages()
    } catch (e) {
      this.d.log(`replay: reading the transcript failed: ${reason(e)}`)
      return []
    }
    const batch = transcriptItems(main)
    const ids = agentIdsOf(main).slice(-MAX_AGENT_READS)
    const read = async (agentId: string): Promise<ReplayItem[]> => {
      try {
        return agentItems(await this.d.messages({ agentId }))
      } catch (e) {
        this.d.log(`replay: reading the transcript of agent ${agentId} failed: ${reason(e)}`)
        return []
      }
    }
    // A few at a time, so a slow engine does not multiply the delay. The batch keeps the order of the ids.
    for (let i = 0; i < ids.length; i += AGENT_READ_CONCURRENCY) {
      for (const items of await Promise.all(ids.slice(i, i + AGENT_READ_CONCURRENCY).map(read))) batch.push(...items)
    }
    return batch
  }
}

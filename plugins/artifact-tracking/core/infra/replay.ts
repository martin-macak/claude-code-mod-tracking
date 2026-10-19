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

export class Replay {
  constructor(private readonly d: { messages(): Promise<unknown>; log(line: string): void }) {}

  /** Reads the transcript once. A failed read logs one line and gives an empty batch: the session still starts. */
  async collect(): Promise<readonly ReplayItem[]> {
    try {
      return transcriptItems(await this.d.messages())
    } catch (e) {
      this.d.log(`replay: reading the transcript failed: ${reason(e)}`)
      return []
    }
  }
}

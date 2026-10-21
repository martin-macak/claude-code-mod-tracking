// A LifecycleManager over fakePorts with the drivers of a turn: `start` and `end` of a main-loop turn, the person's prompt row,
// a Bash call, a spawn, and the reads of the ledger, the pane rows and `/track turn`. The tests of the turn lineage of slot rows
// (issue #133) use it, with the real tracker under test or a recording one.

import type { Json } from '../../core/interfaces/items'
import type { TurnLedger, TurnRecord } from '../../core/interfaces/turns'
import type { TreeRow } from '../../core/interfaces/view'
import { emptyLedger } from '../../core/lib/turns'
import { managerWorld } from './manager'

export function turnWorld(o: Parameters<typeof managerWorld>[0] = {}) {
  const t = managerWorld(o)
  const { m, w } = t
  const ledger = () => (w.state.get('turns') as unknown as TurnLedger | undefined) ?? emptyLedger()
  const rec = (ord: number): TurnRecord => ledger().turns.find(x => x.ord === ord)!
  const start = (turnId: string, text = '') => m.turnStart(w.ports, { turnId, text })
  const end = (turnId: string) =>
    m.turnComplete(w.ports, {
      input: { turnId, reason: 'answer', isAborted: false, durationMs: 5, answer: '' } as Json,
    })
  /** A turn with nothing in it. */
  const idle = async (n: number) => {
    await start(`turn-${n}`, `question ${n}`)
    await end(`turn-${n}`)
  }
  /** One finished Bash call. `result` is what the engine answered; `extra` adds `agentId`, `toolUseId`, `cwdBefore`. */
  const bash = (command = 'ls', extra: Record<string, unknown> = {}, result: Json = {}) =>
    m.toolCall(w.ports, { tool: 'Bash', input: { tool: 'Bash', command } as Json, result, ...extra })
  const prompt = (text: string) =>
    m.row(w.ports, { door: 'prompt', origin: 'composer', isMeta: false, hasMessage: true, text })
  const spawn = (agentId: string, toolUseId: string, input: Record<string, unknown> = {}) =>
    m.agentSpawn(w.ports, {
      input: { tool_use_id: toolUseId, background: true, ...input } as Json,
      answer: { agentId } as Json,
    })
  const text = async (args: string) => (await m.track(w.ports, args)).text
  const rows = async (): Promise<readonly TreeRow[]> =>
    (await m.paneData(w.ports, { selected: null, expanded: new Set() })).flatMap(s => s.rows)
  return { ...t, ledger, rec, start, end, idle, bash, prompt, spawn, text, rows }
}

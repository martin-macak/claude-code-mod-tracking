// EventBus: a domain event kind maps to handlers. TrackerHost fills it at init from each tracker's declared events.
// The bus knows no tracker, no config and no `$`. A handler failure is logged and isolated.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.5. Plan decision D11 sets the modes.

import type { Json, JsonObject } from '../interfaces/items'
import type { TrackerEvents } from '../interfaces/tracker'

/** Every event kind a tracker can declare. */
export type BusKind = keyof TrackerEvents<JsonObject, Json>

/**
 * `sequential`: one handler after the other, in tracker `order`. `parallel`: every handler starts at once.
 * `agentSpawn` is sequential because repos reads the ledger row that auto writes for the same spawn (D11).
 */
export const MODE: Readonly<Record<BusKind, 'sequential' | 'parallel'>> = Object.freeze({
  start: 'sequential',
  agentSpawn: 'sequential',
  sessionChanged: 'sequential',
  command: 'sequential',
  dismissed: 'sequential',
  row: 'parallel',
  toolCall: 'parallel',
  turnComplete: 'parallel',
  tick: 'parallel',
  replay: 'parallel',
})

type Run = (ev: unknown, via: unknown) => void | Promise<void>
type Filter = { tools?: readonly string[]; doors?: readonly string[] }
type Entry = { owner: string; order: number; run: Run; filter?: Filter }

/** Whether a handler with this filter takes the event. A missing filter takes every event of the kind. */
function accepts(kind: BusKind, filter: Filter | undefined, ev: unknown): boolean {
  if (kind === 'toolCall' && filter?.tools) return filter.tools.includes((ev as { tool?: string }).tool ?? '')
  if (kind === 'row' && filter?.doors) return filter.doors.includes((ev as { door?: string }).door ?? '')
  return true
}

export class EventBus {
  private readonly entries = new Map<BusKind, Entry[]>()

  constructor(private readonly d: { log(line: string): void }) {}

  /** Handlers with the same `order` run in the order they were added. */
  add(kind: BusKind, owner: string, order: number, run: Run, filter?: Filter): void {
    const list = this.entries.get(kind) ?? []
    list.push({ owner, order, run, filter })
    list.sort((a, b) => a.order - b.order)
    this.entries.set(kind, list)
  }

  /** True when some `toolCall` handler takes this tool. The `tool.call` hook skips the work when none does. */
  wants(tool: string): boolean {
    return (this.entries.get('toolCall') ?? []).some(e => accepts('toolCall', e.filter, { tool }))
  }

  /**
   * Calls the handlers of `kind` that accept `ev`. `via` goes to each as its second argument (the dispatch's ports).
   * `only` limits the call to the handlers of one owner (a sub-command a tracker declared).
   * Never rejects. In a parallel kind every handler has started when `emit` returns its promise.
   */
  async emit(kind: BusKind, ev: unknown, via: unknown, only?: string): Promise<void> {
    const list = (this.entries.get(kind) ?? []).filter(
      e => (only === undefined || e.owner === only) && accepts(kind, e.filter, ev),
    )
    if (MODE[kind] === 'sequential') {
      for (const e of list) await this.call(kind, e, ev, via)
      return
    }
    await Promise.all(list.map(e => this.call(kind, e, ev, via)))
  }

  private async call(kind: BusKind, e: Entry, ev: unknown, via: unknown): Promise<void> {
    try {
      await e.run(ev, via)
    } catch (err) {
      this.d.log(`bus: ${kind} failed in ${e.owner}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

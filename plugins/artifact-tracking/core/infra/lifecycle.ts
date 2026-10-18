// LifecycleManager (first slice): the session switch, `session.end` and `/track clear` over data slots.
// It builds SessionWatch and Persistence from the ports of the first hook of a load. It names no tracker and holds no `$`.
// `end` stores the leaving session and keeps a snapshot. The switch that follows carries it (`/clear`) or loads the
// stored copy of the new id (`/resume`). Later tasks add the start sequence, the bus and the tick.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6. Plan: L3 Task 5, decisions D6, D8, D9.

import type { GlobalConfig } from '../interfaces/config'
import type { ItemsHost, Json } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DataSlot, PendingEnd, Snapshot } from '../interfaces/slots'
import type { FactsPort } from '../interfaces/tracker'
import { Facts } from './facts'
import { Persistence } from './persistence'
import { SessionWatch, type Switch } from './session'

export interface LifecycleDeps {
  /** The item host: its list is the `items` slot, and it hears of a switch. */
  items: Pick<ItemsHost, 'slot' | 'sessionChanged'>
  /** Slots that a tracker will own later. Until it moves out of register.tsx, register.tsx passes them here. */
  extraSlots?: readonly DataSlot[]
  global: GlobalConfig
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class LifecycleManager {
  readonly facts: FactsPort = new Facts()
  readonly watch: SessionWatch
  /** register.tsx still calls the store paths itself (touch, flush, read, legacy sweep) until Tasks 8 to 11 move them in. */
  readonly persistence: Persistence

  constructor(
    private readonly d: LifecycleDeps,
    private readonly ports: Ports,
  ) {
    this.watch = new SessionWatch({
      id: () => ports.session.id(),
      onSwitch: sw => this.onSwitch(sw),
      log: ports.log,
    })
    this.persistence = new Persistence({
      store: ports.store,
      clock: ports.clock,
      sessionId: () => ports.session.id(),
      slots: () => this.slots(),
      limits: () => ({
        flushMs: d.global.refresh.flushMs,
        keepSessions: d.global.store.keepSessions,
        maxBytes: d.global.store.maxBytes,
      }),
      beforeFlush: async () => {
        await this.watch.check() // a flush is an entry: a /clear since the last change is carried first
      },
      log: ports.log,
    })
  }

  get generation(): number {
    return this.watch.generation
  }

  /** The first step of every hook that reads or writes session data. `ports` are the dispatch's own. */
  async entry(_ports: Ports): Promise<void> {
    await this.watch.check()
  }

  /**
   * `session.end`: stores the leaving session within `budgetMs` and keeps its snapshot for the switch. Run it before
   * `next(e)`. A failure is logged: the switch then carries from the stored copy.
   */
  async end(ports: Ports, endReason: string, budgetMs: number): Promise<void> {
    await this.watch.check() // a switch no hook has seen yet is carried before this one is saved
    const id = await ports.session.id()
    const pending: PendingEnd = { reason: endReason, fromId: id, at: await ports.clock.now() }
    let snapshot: Snapshot
    try {
      snapshot = await this.persistence.end(id, budgetMs, pending)
    } catch (e) {
      this.ports.log(`lifecycle: end of ${id} failed: ${reason(e)}`)
      snapshot = { from: id, slots: {} }
    }
    this.watch.ended(pending, snapshot)
  }

  /** `/track clear`: older jobs stop writing, the persisted slots empty, the stored copy goes. Run-scoped slots stay (D10). */
  async clear(ports: Ports): Promise<void> {
    this.watch.bump()
    for (const slot of this.slots()) if (slot.persist) await slot.clear?.()
    await this.persistence.forget(await ports.session.id())
  }

  private slots(): readonly DataSlot[] {
    return [this.d.items.slot, ...(this.d.extraSlots ?? [])]
  }

  /**
   * The switch. Every step writes through the raw paths and never calls `watch.check()`: that is single flight and
   * would wait for this switch (Review Focus 2). A failing step is logged and the next one still runs.
   */
  private async onSwitch(sw: Switch): Promise<void> {
    const slots = this.slots()
    const run = (await this.persistence.loadRun()).run ?? {}
    // The run-scoped slots go first: the dismiss list and the proofs must be there before an item loads (D9).
    for (const slot of slots) if (!slot.persist) await this.carry(slot, sw.snapshot?.slots[slot.id] ?? run[slot.id])
    const persisted = slots.filter(slot => slot.persist)
    if (sw.kind === 'clear') {
      const from = await this.persistence.read(sw.from)
      for (const slot of persisted) await this.carry(slot, sw.snapshot?.slots[slot.id] ?? from?.[slot.id])
    } else if (!(await this.warm())) {
      // A resume loads the stored copy of the new id. A session that already holds items keeps them (a reload kept its state).
      const to = await this.persistence.read(sw.to)
      for (const slot of persisted) {
        const value = to?.[slot.id]
        if (value !== undefined) await this.guard(slot.id, () => slot.restore(value, 'load'))
      }
    }
    await this.guard('sessionChanged', () => this.d.items.sessionChanged({ from: sw.from, to: sw.to, kind: sw.kind }))
    await this.guard('clearRun', () => this.persistence.clearRun())
  }

  private async carry(slot: DataSlot, value: Json | undefined): Promise<void> {
    if (value !== undefined) await this.guard(slot.id, () => slot.restore(value, 'carry'))
  }

  /** True when the items slot already holds something. */
  private async warm(): Promise<boolean> {
    const items = this.d.items.slot
    return !items.empty(await items.read())
  }

  private async guard(what: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step()
    } catch (e) {
      this.ports.log(`lifecycle: ${what} failed in a switch: ${reason(e)}`)
    }
  }
}

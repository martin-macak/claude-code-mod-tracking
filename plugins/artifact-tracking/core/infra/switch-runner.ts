// SwitchRunner: moves the data when the session id changed. It carries the run-scoped slots, then carries the persisted
// ones (`/clear`) or loads the stored copy of the new id (`/resume`), and replays the transcript on a cold load. The start
// sequence shares `loadSession` and `replay` with it. It names no tracker and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.6 (Switch) and 5.6.1. Plan: L3 Tasks 5 to 8, D6 to D9.

import type { ItemsHost, Json } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DataSlot } from '../interfaces/slots'
import type { EventBus } from './bus'
import type { Persistence } from './persistence'
import type { Replay } from './replay'
import type { Switch } from './session'
import { guard } from './steps'

export interface SwitchDeps {
  items: ItemsHost
  persistence: Persistence
  bus: EventBus
  replayer: Replay
  /** Every slot the manager stores: the item list, the extra slots and the slots of the live trackers. */
  slots(): readonly DataSlot[]
  /** The ports of the first hook of the load: the bus and the log use them. */
  ports: Ports
}

export class SwitchRunner {
  constructor(private readonly d: SwitchDeps) {}

  /**
   * The switch. Every step writes through the raw paths and never calls `watch.check()`: that is single flight and
   * would wait for this switch (Review Focus 2). A failing step is logged and the next one still runs. The item host
   * hears of the switch first, so it forgets what belonged to the old session (the repo) before a load or the replay
   * looks it up for the new one. A reset after the load would throw that lookup away.
   */
  async run(sw: Switch): Promise<void> {
    const { items, persistence } = this.d
    const ev = { from: sw.from, to: sw.to, kind: sw.kind }
    await this.guarded('sessionChanged', () => items.sessionChanged(ev))
    const slots = this.d.slots()
    const run = (await persistence.loadRun()).run ?? {}
    // The run-scoped slots go first: the dismiss list and the proofs must be there before an item loads (D9). `v2:run`
    // stands in only when this load saw no end (the reload gap). After an end the snapshot is the whole truth: a
    // `v2:run` that an earlier process left must not reach a slot the snapshot holds nothing for.
    for (const slot of slots)
      if (!slot.persist) await this.carry(slot, sw.snapshot ? sw.snapshot.slots[slot.id] : run[slot.id])
    const persisted = slots.filter(slot => slot.persist)
    if (sw.kind === 'clear') {
      const from = await persistence.read(sw.from)
      for (const slot of persisted) await this.carry(slot, sw.snapshot?.slots[slot.id] ?? from?.[slot.id])
    } else if (await this.itemsEmpty()) {
      // A resume loads the stored copy of the new id. A session that already holds items keeps them (a reload kept its state).
      await this.loadSession(sw.to, 'a switch')
    }
    await this.d.bus.emit('sessionChanged', ev, this.d.ports)
    await this.guarded('clearRun', () => persistence.clearRun())
  }

  /** The persisted slots from the stored copy of `id`, then the transcript. */
  async loadSession(id: string, where: string): Promise<void> {
    const stored = await this.d.persistence.read(id)
    for (const slot of this.d.slots().filter(s => s.persist)) {
      const value = stored?.[slot.id]
      if (value !== undefined) await this.guarded(slot.id, () => slot.restore(value, 'load'), where)
    }
    // The transcript fills in what the stored copy lacks, whether or not there was a copy (D7).
    await this.guarded('replay', () => this.replay(), where)
    // A row that drew before the data was here (the stub of `/track qa` after a resume: its calls were not in the slot) draws
    // again only at a redraw, and the tick is the next one, up to 30 s away (issue #246). One call, after the replay.
    this.d.ports.ui.invalidate()
  }

  /**
   * Reads the transcript back and gives it to the item host and the bus, on a cold load. It writes through the raw
   * paths, so it may run inside a switch. Nothing in the batch is a live row: capture and the row handlers skip it.
   */
  async replay(): Promise<void> {
    const batch = await this.d.replayer.collect()
    await this.d.items.replay(batch)
    await this.d.bus.emit('replay', batch, this.d.ports)
  }

  /** True when the items slot holds nothing: a cold load. */
  async itemsEmpty(): Promise<boolean> {
    const items = this.d.items.slot
    return items.empty(await items.read())
  }

  private async carry(slot: DataSlot, value: Json | undefined): Promise<void> {
    if (value !== undefined) await this.guarded(slot.id, () => slot.restore(value, 'carry'))
  }

  private guarded(what: string, step: () => Promise<unknown>, where?: string): Promise<void> {
    return guard(this.d.ports.log, what, step, where)
  }
}

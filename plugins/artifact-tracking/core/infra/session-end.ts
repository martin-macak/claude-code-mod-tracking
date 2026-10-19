// SessionEnd: what `session.end` does. It stores the leaving session within a budget and keeps a snapshot for the switch
// that follows (`/clear` carries it, `/resume` loads the stored copy of the new id). An exit reason disposes the trackers
// and the item host. Split from the LifecycleManager, which sequences the hooks and holds no step of its own.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6. Plan: L3 Task 6, D4.

import type { ItemsHost } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { PendingEnd, Snapshot } from '../interfaces/slots'
import type { Persistence } from './persistence'
import type { SessionWatch } from './session'
import { guard, reason } from './steps'
import type { TrackerHost } from './tracker-host'

/** `session.end` reasons after which the process goes away. `clear` and `resume` are switches. */
const EXITS: ReadonlySet<string> = new Set(['prompt_input_exit', 'logout', 'other'])

export interface SessionEndDeps {
  /** The start of the load, without the write of the config file: an end can be the first hook of a load (C16). */
  started(ports: Ports): Promise<void>
  watch: Pick<SessionWatch, 'lastId' | 'check' | 'ended'>
  persistence: Pick<Persistence, 'end'>
  host: Pick<TrackerHost, 'dispose'>
  items: Pick<ItemsHost, 'dispose'>
  /** The ports of the first hook of the load: a failure is logged there. */
  log(line: string): void
}

export class SessionEnd {
  constructor(private readonly d: SessionEndDeps) {}

  /**
   * Stores the leaving session within `budgetMs` and keeps its snapshot for the switch. Run it before `next(e)`. A failure
   * is logged: the switch then carries from the stored copy. An exit reason disposes the trackers.
   * The reads of the id and the clock may fail too (a `$` call over its bound). The end then goes on with the last id
   * the watch saw and the wall clock, so the next switch still knows how the session left.
   */
  async run(ports: Ports, endReason: string, budgetMs: number): Promise<void> {
    const { watch, log } = this.d
    await this.d.started(ports) // an end can be the first hook of a load (a hot reload, then /clear)
    let id = watch.lastId
    let at = ports.clock.wall()
    try {
      await watch.check() // a switch no hook has seen yet is carried before this one is saved
      id = await ports.session.id()
      at = await ports.clock.now()
    } catch (e) {
      log(`lifecycle: end could not read the session: ${reason(e)}`)
    }
    if (id !== undefined) {
      const pending: PendingEnd = { reason: endReason, fromId: id, at }
      let snapshot: Snapshot
      try {
        snapshot = await this.d.persistence.end(id, budgetMs, pending)
      } catch (e) {
        log(`lifecycle: end of ${id} failed: ${reason(e)}`)
        snapshot = { from: id, slots: {} }
      }
      watch.ended(pending, snapshot)
    }
    if (EXITS.has(endReason)) {
      this.d.host.dispose()
      await guard(log, 'item dispose', async () => this.d.items.dispose(), 'the end')
    }
  }
}

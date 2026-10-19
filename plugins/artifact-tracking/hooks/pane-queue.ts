// WorkQueue: the work behind the pane's Buttons. Most of it runs in one chain, so two quick presses see each other's
// writes. A tracker key runs outside the chain: its own work may take long and must not hold the keys that come after.
// A failure is logged as one line and never rejects. Plan: L6 Task 11.

import { reason } from '../core/infra/steps'
import type { Ports } from '../core/interfaces/ports'

export class WorkQueue {
  private busy: Promise<void> = Promise.resolve()
  private readonly loose = new Set<Promise<void>>()

  /** Runs after the work queued before it. */
  queue(p: Ports, name: string, step: () => Promise<void>): void {
    this.busy = this.busy.then(() => this.run(p, name, step))
  }

  /** Runs at once, outside the chain. */
  detach(p: Ports, name: string, step: () => Promise<void>): void {
    const work = this.run(p, name, step)
    this.loose.add(work)
    void work.finally(() => this.loose.delete(work))
  }

  /** Resolves when all the work started so far has finished. */
  async idle(): Promise<void> {
    await this.busy
    await Promise.all(this.loose)
  }

  private run(p: Ports, name: string, step: () => Promise<void>): Promise<void> {
    return step().catch(e => void p.log(`pane: ${name} failed: ${reason(e)}`))
  }
}

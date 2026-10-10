// AutoScheduler (spec A16): a fixed window for events, an immediate path for tick and manual, one round at a time.
// Built on the coordinator's timer pattern (timerAt, the overdue-timer replacement, idle). No `$`.

import type { AutoReason, Now } from '../contracts'
import { LIMITS } from '../contracts'
import type { Timer } from '../refresh/coordinator'

export type SchedulerDeps = {
  now: Now
  after: (ms: number, fn: () => void | Promise<void>) => Timer
  run: (reasons: ReadonlySet<AutoReason>) => Promise<void>
  onError?: (err: unknown) => void
}

export class AutoScheduler {
  private running = false
  private queued?: Set<AutoReason>
  private pending = new Set<AutoReason>()
  private timer?: Timer
  /** When the window timer was armed. A timer the engine refused never fires; this tells it apart. */
  private timerAt = 0
  private waiters: Array<() => void> = []

  constructor(private readonly deps: SchedulerDeps) {}

  get busy(): boolean {
    return this.running
  }

  /**
   * `tick` and `manual` run at once. The other reasons join a fixed window of `LIMITS.autoDebounceMs`
   * that the first of them arms. A later kick joins it and does not move its end, so a burst of events
   * (a workflow that spawns many agents) gives at most one round per window.
   */
  kick(reason: AutoReason): void {
    if (reason === 'tick' || reason === 'manual') {
      void this.exec(new Set([reason]))
      return
    }
    this.pending.add(reason)
    const at = this.deps.now()
    if (this.timer && at - this.timerAt > 2 * LIMITS.autoDebounceMs) {
      // The timer is long overdue: the engine never ran it. Arm a new one. The pending reasons stay.
      this.timer.cancel()
      this.timer = undefined
    }
    if (this.timer) return
    this.timerAt = at
    this.timer = this.deps.after(LIMITS.autoDebounceMs, () => {
      const reasons = this.pending
      this.pending = new Set()
      this.timer = undefined
      return this.exec(reasons)
    })
  }

  /** Settles when no round is in flight or queued. */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  private async exec(reasons: ReadonlySet<AutoReason>): Promise<void> {
    if (this.running) {
      this.queued = new Set([...(this.queued ?? []), ...reasons])
      return
    }
    this.running = true
    try {
      await this.once(reasons)
      while (this.queued) {
        const next = this.queued
        this.queued = undefined
        await this.once(next)
      }
    } finally {
      this.running = false
      const done = this.waiters
      this.waiters = []
      for (const w of done) w()
    }
  }

  /** Never rejects. */
  private async once(reasons: ReadonlySet<AutoReason>): Promise<void> {
    try {
      await this.deps.run(reasons)
    } catch (err) {
      try {
        this.deps.onError?.(err)
      } catch {
        // The error handler must not break a round.
      }
    }
  }
}

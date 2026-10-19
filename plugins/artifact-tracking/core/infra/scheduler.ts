// Scheduler: the one tick of the mod. It arms a single `clock.every`, and a watchdog arms it again.
// A refused period ends a `clock.every` for good (E18), so every hook entry calls `ensure()`. It re-arms when the
// last beat is over two periods old, or when the period changed. `due` gives each owner its own period on that tick.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6 (Tick). Plan: L3 Task 6, decision D17.

import type { Timer } from '../interfaces/ports'

export interface TickDeps {
  /** Engine time. The watchdog and `due` use it, so the kit's mock clock drives them. */
  now(): Promise<number>
  /** The engine call returns the handle at once. */
  every(ms: number, fn: () => void): Timer
  /** The tick period. A change re-arms the interval. */
  periodMs(): number
  /** One beat. */
  beat(): Promise<void>
  log(line: string): void
}

/** A timer can fire a few ms early in clock terms. A beat that early still counts as the period. */
const JITTER_MS = 1000

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class Scheduler {
  private timer: Timer | null = null
  private armedPeriod = 0
  /** Engine time of the arm, then of each beat. */
  private lastBeat = 0
  private readonly lastRun = new Map<string, number>()

  constructor(private readonly d: TickDeps) {}

  /** Arms the interval, or arms it again when the last beat is over two periods old or the period changed. Never rejects. */
  async ensure(): Promise<void> {
    try {
      const now = await this.d.now()
      const period = this.d.periodMs()
      if (this.timer && period === this.armedPeriod && now - this.lastBeat <= 2 * period) return
      this.stop()
      this.lastBeat = now
      this.armedPeriod = period
      // The engine runs the callback and ignores what it returns; the mini clock of the tests awaits it.
      this.timer = this.d.every(period, (() => this.beat()) as () => void)
    } catch {
      // No tick this time. The next hook entry tries again.
    }
  }

  /**
   * True once per `everyMs` for this owner, then it counts from `now`. A tracker with a longer period than the tick
   * runs on the beat that comes at its time. Beats can come a few ms early, so that much is forgiven.
   */
  due(owner: string, everyMs: number, now: number): boolean {
    const last = this.lastRun.get(owner)
    if (last !== undefined && now - last < everyMs - JITTER_MS) return false
    this.lastRun.set(owner, now)
    return true
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = null
  }

  private async beat(): Promise<void> {
    try {
      this.lastBeat = await this.d.now()
    } catch {
      // Keep the old beat: the watchdog will arm the interval again.
    }
    try {
      await this.d.beat()
    } catch (e) {
      this.d.log(`scheduler: beat failed: ${reason(e)}`)
    }
  }
}

// SessionWatch: compares the session id with the last one seen and runs one switch when it moved.
// `session.end` tells it how the old session left (`ended`), so a switch knows `clear` from `resume` and has the data.
// The generation goes up on every switch and on `/track clear`: an async job of an older generation drops its write.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6 (Switch). Plan: L3 Task 5.

import type { PendingEnd, Snapshot } from '../interfaces/slots'

/** One change of the session id. `snapshot` is what `session.end` kept of `from`, when this load saw it end. */
export type Switch = { from: string; to: string; kind: 'clear' | 'resume'; snapshot?: Snapshot }

export interface SessionWatchDeps {
  id(): Promise<string>
  /** Moves the data. It must not call `check()`: the check is single flight and would wait for itself. */
  onSwitch(sw: Switch): Promise<void>
  log(line: string): void
}

export class SessionWatch {
  private last: string | undefined
  private gen = 0
  private pending: PendingEnd | undefined
  private snapshot: Snapshot | undefined
  private flight: Promise<boolean> | undefined

  constructor(private readonly d: SessionWatchDeps) {}

  get generation(): number {
    return this.gen
  }

  /** The session id last seen. undefined until the first check or `seed`. */
  get lastId(): string | undefined {
    return this.last
  }

  /** The start sequence knows the id: the next check compares with it. */
  seed(id: string): void {
    this.last = id
  }

  /** `session.end` ran for the session that is leaving. The next switch reads this. */
  ended(pending: PendingEnd, snapshot: Snapshot): void {
    this.pending = pending
    this.snapshot = snapshot
  }

  /** A start after a reload honours the `pendingEnd` of `v2:run`: the next check switches from its id, with no snapshot. */
  resumeFrom(pending: PendingEnd): void {
    this.pending = pending
    this.snapshot = undefined
    this.last = pending.fromId
  }

  /**
   * Resolves to whether the id moved. Concurrent callers share one run, and a caller that comes while a switch runs
   * waits for it. The first check with no id seen yet only learns the id.
   */
  check(): Promise<boolean> {
    this.flight ??= this.run().finally(() => {
      this.flight = undefined
    })
    return this.flight
  }

  /** `/track clear`: older jobs must not write. */
  bump(): number {
    return ++this.gen
  }

  /** The check, then the generation: a caller keeps it and compares later. */
  async current(): Promise<number> {
    await this.check()
    return this.gen
  }

  private async run(): Promise<boolean> {
    const id = await this.d.id()
    if (this.last === undefined) {
      this.last = id
      return false
    }
    if (id === this.last) return false
    const from = this.last
    const pending = this.pending
    const sw: Switch = {
      from,
      to: id,
      kind: pending?.reason === 'clear' && pending.fromId === from ? 'clear' : 'resume',
      snapshot: this.snapshot?.from === from ? this.snapshot : undefined,
    }
    this.last = id
    this.gen++
    try {
      await this.d.onSwitch(sw)
    } catch (e) {
      this.d.log(`session: switch ${from} to ${id} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.pending = undefined
    this.snapshot = undefined
    return true
  }
}

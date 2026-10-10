// One breaker per tool (spec section 8). Pure: the caller passes the time.
//   closed --3rd failure in a row--> open --openMs passed--> half-open (one call) --ok--> closed
//                                                                     \--fail--> open

import { LIMITS } from '../contracts'
import type { BreakerState } from '../contracts'

export class CircuitBreaker {
  private st: BreakerState = 'closed'
  private failures = 0
  private until = 0
  private probing = false

  constructor(
    private readonly threshold: number = LIMITS.breakerThreshold,
    private readonly openMs: number = LIMITS.breakerOpenMs,
  ) {}

  get state(): BreakerState {
    return this.st
  }

  /** When an open breaker lets the next probe through. undefined unless open. */
  get openUntil(): number | undefined {
    return this.st === 'open' ? this.until : undefined
  }

  /** Would `allows(now)` say yes? Changes nothing, so callers may ask it for every item. */
  peek(now: number): boolean {
    if (this.st === 'closed') return true
    if (this.st === 'open') return now >= this.until
    return !this.probing
  }

  /** May a call start now? Moves open to half-open when the wait is over; half-open lets one call through. */
  allows(now: number): boolean {
    if (this.st === 'closed') return true
    if (this.st === 'open') {
      if (now < this.until) return false
      this.st = 'half-open'
      this.probing = false
    }
    if (this.probing) return false
    this.probing = true
    return true
  }

  success(): void {
    this.st = 'closed'
    this.failures = 0
    this.probing = false
  }

  failure(now: number): void {
    this.probing = false
    if (this.st === 'half-open') {
      this.open(now)
      return
    }
    this.failures++
    if (this.failures >= this.threshold) this.open(now)
  }

  /** Manual refresh: an open breaker becomes half-open at once. */
  reset(): void {
    if (this.st === 'open') {
      this.st = 'half-open'
      this.probing = false
    }
  }

  private open(now: number): void {
    this.st = 'open'
    this.until = now + this.openMs
    this.failures = 0
  }
}

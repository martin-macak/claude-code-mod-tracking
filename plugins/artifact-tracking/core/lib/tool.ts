// Base class for a CLI tool (spec sections 5 and 8). No `$`: it gets a Runner and a clock.
// Subclasses build argv, parse output, classify each outcome, and update the items.

import type { RefreshTool } from '../interfaces/items'
import type { Now, Runner, RunOpts, RunResult } from '../interfaces/ports'
import type { ToolOutcome, ToolStatus } from '../interfaces/tracker'
import { CircuitBreaker } from './circuit-breaker'
import { GLOBAL_DEFAULTS } from './global-config'
import { firstLine, message } from './text'

// `firstLine` and `message` moved to text.ts (plan L5, Task 2). The tool classes import them from here.
export { firstLine, message }

/** The two timeouts of a tool, read at each call so a changed config file shows at the next one (`global.tools`). */
export type ToolTimeouts = () => { timeoutMs: number; probeTimeoutMs: number }

/** How one call ended, for the breaker. The contract type, under its old name. */
export type Outcome = ToolOutcome

export abstract class Tool<T> implements RefreshTool<T> {
  protected available: boolean | null = null
  protected version?: string
  protected loggedIn: boolean | null = null
  protected lastError?: string
  protected lastRunAt?: number
  private probing?: Promise<boolean>

  constructor(
    readonly name: string,
    protected readonly run: Runner,
    protected readonly now: Now,
    protected readonly breaker: CircuitBreaker = new CircuitBreaker(),
    protected readonly timeouts: ToolTimeouts = () => GLOBAL_DEFAULTS.tools,
  ) {}

  /** Runs `<tool> --version` once and caches the promise. Never rejects. */
  probe(): Promise<boolean> {
    this.probing ??= (async () => {
      try {
        const r = await this.run([this.name, '--version'], { timeoutMs: this.timeouts().probeTimeoutMs })
        this.available = r.exitCode === 0
        if (this.available) this.version = firstLine(r.stdout)
        else this.lastError = firstLine(r.stderr) || `exit ${r.exitCode}`
      } catch (err) {
        this.available = false
        this.lastError = message(err)
      }
      return this.available
    })()
    return this.probing
  }

  get isAvailable(): boolean {
    return this.available === true
  }

  /** No side effects: safe to ask for every item. `exec` takes the breaker's half-open slot. */
  canCall(now: number): boolean {
    return this.isAvailable && this.loggedIn !== false && this.breaker.peek(now)
  }

  reset(): void {
    if (this.loggedIn === false) this.loggedIn = null
    this.breaker.reset()
  }

  status(): ToolStatus {
    const s: ToolStatus = {
      name: this.name,
      available: this.available,
      loggedIn: this.loggedIn,
      breaker: this.breaker.state,
    }
    if (this.version !== undefined) s.version = this.version
    if (this.breaker.openUntil !== undefined) s.openUntil = this.breaker.openUntil
    if (this.lastError !== undefined) s.lastError = this.lastError
    if (this.lastRunAt !== undefined) s.lastRunAt = this.lastRunAt
    return s
  }

  abstract refreshItems(items: T[]): Promise<void>

  /**
   * Runs one command through the breaker. Returns null when the breaker blocks the call (nothing
   * is recorded) or when the call rejects (cannot start, timeout: recorded as a tool failure).
   * Otherwise the caller classifies the result and calls `record` once.
   */
  protected async exec(argv: readonly string[], init?: RunOpts): Promise<RunResult | null> {
    if (!this.breaker.allows(this.now())) return null
    this.lastRunAt = this.now()
    try {
      return await this.run(argv, { timeoutMs: this.timeouts().timeoutMs, ...init })
    } catch (err) {
      this.record('tool-failure', message(err))
      return null
    }
  }

  /** Feeds one outcome to the breaker and the login flag. */
  protected record(outcome: Outcome, detail?: string): void {
    switch (outcome) {
      case 'ok':
      case 'item-error':
        this.loggedIn = true
        this.breaker.success()
        return
      case 'auth':
        this.loggedIn = false
        this.lastError = detail ?? 'not logged in'
        this.breaker.failure(this.now())
        return
      case 'tool-failure':
        this.lastError = detail ?? 'failed'
        this.breaker.failure(this.now())
        return
    }
  }
}

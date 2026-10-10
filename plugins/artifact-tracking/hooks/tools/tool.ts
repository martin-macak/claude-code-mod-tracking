// Base class for a CLI tool (spec sections 5 and 8). No `$`: it gets a Runner and a clock.
// Subclasses build argv, parse output, classify each outcome, and update the items.

import { LIMITS } from '../contracts'
import type { Now, RefreshTool, RunInit, RunResult, Runner, ToolName, ToolStatus } from '../contracts'
import { CircuitBreaker } from './circuit-breaker'

/**
 * How one call ended, for the breaker.
 * `ok` and `item-error` (not found, no permission) are successes for the tool.
 * `tool-failure` (cannot start, timeout, network, 401, unparsable) and `auth` (not logged in) count.
 */
export type Outcome = 'ok' | 'item-error' | 'tool-failure' | 'auth'

export abstract class Tool<T> implements RefreshTool<T> {
  protected available: boolean | null = null
  protected version?: string
  protected loggedIn: boolean | null = null
  protected lastError?: string
  protected lastRunAt?: number
  private probing?: Promise<boolean>

  constructor(
    readonly name: ToolName,
    protected readonly run: Runner,
    protected readonly now: Now,
    protected readonly breaker: CircuitBreaker = new CircuitBreaker(),
  ) {}

  /** Runs `<tool> --version` once and caches the promise. Never rejects. */
  probe(): Promise<boolean> {
    this.probing ??= (async () => {
      try {
        const r = await this.run([this.name, '--version'], { timeoutMs: 10_000 })
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
    const s: ToolStatus = { name: this.name, available: this.available, loggedIn: this.loggedIn, breaker: this.breaker.state }
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
  protected async exec(argv: readonly string[], init?: RunInit): Promise<RunResult | null> {
    if (!this.breaker.allows(this.now())) return null
    this.lastRunAt = this.now()
    try {
      return await this.run(argv, { timeoutMs: LIMITS.toolTimeoutMs, ...init })
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

export function firstLine(s: string): string {
  return s.trim().split('\n')[0]?.trim() ?? ''
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// A CLI tool (spec sections 5 and 8). No `$`: it gets a Runner and a clock.
// `CliTool` is the handle: the probe, the timeouts, the breaker and the login flag of one CLI. ToolRunner builds one
// per `ToolSpec`. `Tool` is the base of the tool classes: they build argv, parse output, classify each outcome and
// update the items, and reach the CLI only through a handle.

import type { RefreshTool } from '../interfaces/items'
import type { Now, Runner, RunOpts, RunResult } from '../interfaces/ports'
import type { Breaker, ToolHandle, ToolOutcome, ToolStatus } from '../interfaces/tracker'
import { CircuitBreaker } from './circuit-breaker'
import { GLOBAL_DEFAULTS } from './global-config'
import { firstLine, message } from './text'

// `firstLine` and `message` moved to text.ts (plan L5, Task 2). The tool classes import them from here.
export { firstLine, message }

/** The two timeouts of a tool, read at each call so a changed config file shows at the next one (`global.tools`). */
export type ToolTimeouts = () => { timeoutMs: number; probeTimeoutMs: number }

/** How one call ended, for the breaker. The contract type, under its old name. */
export type Outcome = ToolOutcome

/** What a handle needs of its `ToolSpec`: the probe argv and the two timeouts, each read at its call. */
export interface CliSpec {
  readonly id: string
  readonly probe: readonly string[]
  timeoutMs(): number
  probeTimeoutMs(): number
}

export class CliTool implements ToolHandle {
  private available: boolean | null = null
  private version?: string
  private loggedIn: boolean | null = null
  private lastError?: string
  private lastRunAt?: number
  private site?: string
  private probing?: Promise<boolean>

  constructor(
    private readonly spec: CliSpec,
    private readonly run: Runner,
    private readonly now: Now,
    private readonly breaker: Breaker = new CircuitBreaker(),
    /** Builds a spare breaker with the numbers of this tool. Default: the numbers of `GLOBAL_DEFAULTS`. */
    private readonly spareBreaker: () => Breaker = () => new CircuitBreaker(),
  ) {}

  spare(): Breaker {
    return this.spareBreaker()
  }

  get id(): string {
    return this.spec.id
  }

  /** Runs the probe argv once and caches the promise. Never rejects. */
  probe(): Promise<boolean> {
    this.probing ??= (async () => {
      try {
        const r = await this.run(this.spec.probe, { timeoutMs: this.spec.probeTimeoutMs() })
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

  peek(now: number): boolean {
    return this.breaker.peek(now)
  }

  reset(): void {
    if (this.loggedIn === false) this.loggedIn = null
    this.breaker.reset()
  }

  setSite(site: string | undefined): void {
    this.site = site
  }

  status(): ToolStatus {
    const s: ToolStatus = {
      name: this.spec.id,
      available: this.available,
      loggedIn: this.loggedIn,
      breaker: this.breaker.state,
    }
    if (this.version !== undefined) s.version = this.version
    if (this.breaker.openUntil !== undefined) s.openUntil = this.breaker.openUntil
    if (this.lastError !== undefined) s.lastError = this.lastError
    if (this.lastRunAt !== undefined) s.lastRunAt = this.lastRunAt
    if (this.site) s.site = this.site
    return s
  }

  raw(argv: readonly string[], init?: RunOpts): Promise<RunResult> {
    return this.run(argv, { timeoutMs: this.spec.timeoutMs(), ...init })
  }

  /**
   * Runs one command through the breaker. Returns null when the breaker blocks the call (nothing is recorded) or when
   * the call rejects (cannot start, timeout: recorded as a tool failure). Otherwise the caller classifies the result
   * and calls `record` once.
   */
  async exec(argv: readonly string[], init?: RunOpts): Promise<RunResult | null> {
    if (!this.breaker.allows(this.now())) return null
    this.lastRunAt = this.now()
    try {
      return await this.raw(argv, init)
    } catch (err) {
      this.record('tool-failure', message(err))
      return null
    }
  }

  /** Feeds one outcome to the breaker and the login flag. */
  record(outcome: ToolOutcome, detail?: string): void {
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

/**
 * The base of a tool class. It reaches the CLI through a handle. Given a `Runner` it builds a private handle with the
 * probe `[name, '--version']` (the tool classes of the unit tests). Given a handle it uses that one, so the breaker and
 * the statuses are the handle's.
 */
export abstract class Tool<T> implements RefreshTool<T> {
  readonly name: string
  protected readonly handle: ToolHandle

  constructor(
    name: string,
    run: Runner | ToolHandle,
    protected readonly now: Now,
    breaker?: Breaker,
    timeouts: ToolTimeouts = () => GLOBAL_DEFAULTS.tools,
  ) {
    this.handle =
      typeof run === 'function'
        ? new CliTool(
            {
              id: name,
              probe: [name, '--version'],
              timeoutMs: () => timeouts().timeoutMs,
              probeTimeoutMs: () => timeouts().probeTimeoutMs,
            },
            run,
            now,
            breaker,
          )
        : run
    this.name = this.handle.id
  }

  /** Runs the probe once and caches the promise. Never rejects. */
  probe(): Promise<boolean> {
    return this.handle.probe()
  }

  get isAvailable(): boolean {
    return this.handle.isAvailable
  }

  /** No side effects: safe to ask for every item. `exec` takes the breaker's half-open slot. */
  canCall(now: number): boolean {
    return this.handle.canCall(now)
  }

  reset(): void {
    this.handle.reset()
  }

  status(): ToolStatus {
    return this.handle.status()
  }

  abstract refreshItems(items: T[]): Promise<void>

  /** Not probed yet: null. */
  protected get available(): boolean | null {
    return this.handle.status().available
  }

  /** false: a call proved the tool is not logged in. */
  protected get loggedIn(): boolean | null {
    return this.handle.status().loggedIn
  }

  protected get lastError(): string | undefined {
    return this.handle.status().lastError
  }

  /** The breaker alone, now. Not the probe, not the login flag. */
  protected get breakerAllows(): boolean {
    return this.handle.peek(this.now())
  }

  protected exec(argv: readonly string[], init?: RunOpts): Promise<RunResult | null> {
    return this.handle.exec(argv, init)
  }

  /** A run outside the breaker, on the tool's timeout. Rejects as the runner does. */
  protected raw(argv: readonly string[], init?: RunOpts): Promise<RunResult> {
    return this.handle.raw(argv, init)
  }

  protected record(outcome: Outcome, detail?: string): void {
    this.handle.record(outcome, detail)
  }
}

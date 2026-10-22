// ToolRunner: one handle per declared ToolSpec. Core owns the probe, the timeouts and the circuit breaker of each CLI;
// a tracker declares its tool as data and reaches it through `port(owner).handle(id)`. It names no tool and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.8 and 5.13.
// Plan: L5 Task 3, K13. L4 C5: the breaker numbers are read once, at `build`. The timeouts are read at each call.

import type { GlobalConfig } from '../interfaces/config'
import type { AtomPort, RunOpts, RunResult } from '../interfaces/ports'
import type { Breaker, ToolPort, ToolSpec, ToolStatus } from '../interfaces/tracker'
import { CircuitBreaker } from '../lib/circuit-breaker'
import { CliTool } from '../lib/tool'

export interface ToolRunnerDeps {
  run(argv: readonly string[], opts: RunOpts): Promise<RunResult>
  now(): number
  global(): GlobalConfig
  tools: AtomPort<Record<string, ToolStatus>>
  log(line: string): void
  /** False for an owner whose tracker is off: its handles exist, but `start` never probes them. Default: all live. */
  live?(owner: string): boolean
  /** Builds the breaker of one handle. Default: `CircuitBreaker`. */
  breaker?(limits: { threshold: number; openMs: number }): Breaker
}

/** The status as the pane shows it. `lastRunAt` moves on every call and no view shows it, so it is not compared (A22). */
const shown = (s: ToolStatus | undefined): string => JSON.stringify({ ...s, lastRunAt: undefined })

export class ToolRunner {
  private readonly handles = new Map<string, CliTool>()
  private readonly owners = new Map<string, string>()
  private probes: Promise<unknown>[] = []

  constructor(private readonly d: ToolRunnerDeps) {}

  /** Once per load. A duplicate id keeps the first owner's handle and logs one line. */
  build(specs: readonly { owner: string; spec: ToolSpec }[]): void {
    for (const { owner, spec } of specs) {
      const first = this.owners.get(spec.id)
      if (first !== undefined) {
        this.d.log(`tools: ${owner} declares ${spec.id}, owned by ${first}. The later one is off.`)
        continue
      }
      // The breaker is an object that holds its numbers, so it reads them once. The spec overrides a part.
      const limits = { ...this.d.global().tools.breaker, ...spec.breaker }
      const breaker = this.d.breaker ? this.d.breaker(limits) : new CircuitBreaker(limits.threshold, limits.openMs)
      const cli = {
        id: spec.id,
        probe: spec.probe,
        timeoutMs: () => spec.timeoutMs ?? this.d.global().tools.timeoutMs,
        probeTimeoutMs: () => this.d.global().tools.probeTimeoutMs,
      }
      const spare = () =>
        this.d.breaker ? this.d.breaker(limits) : new CircuitBreaker(limits.threshold, limits.openMs)
      this.handles.set(
        spec.id,
        new CliTool(cli, (argv, init) => this.d.run(argv, init ?? {}), this.d.now, breaker, spare),
      )
      this.owners.set(spec.id, owner)
    }
  }

  /** What a tracker runs CLIs through: the handles it declared, and the raw run for the rest (K13). */
  port(owner: string): ToolPort {
    return {
      handle: id => (this.owners.get(id) === owner ? this.handles.get(id) : undefined),
      run: (_tool, argv, opts) => this.d.run(argv, opts),
    }
  }

  /** Probes each live handle without waiting, then publishes the statuses. A second call keeps the probes it has. */
  start(): void {
    this.probes = this.liveHandles().map(h => h.probe())
    void this.settle()
      .then(() => this.publish())
      .catch(() => {})
  }

  /** Every probe that `start` began has settled. Before `start` there is nothing to wait for. */
  async settle(): Promise<void> {
    await Promise.allSettled(this.probes)
  }

  /** `/track refresh`: every tool forgets a failed login and an open breaker. */
  resetAll(): void {
    for (const h of this.handles.values()) h.reset()
  }

  /** Reads first and writes nothing when no field the pane shows changed, so a quiet tick makes no write (A22). */
  async publish(): Promise<void> {
    const next: Record<string, ToolStatus> = {}
    for (const [id, h] of this.handles) next[id] = h.status()
    const cur = await this.d.tools.get()
    if (Object.keys(next).every(id => shown(cur[id]) === shown(next[id]))) return
    await this.d.tools.update(() => next)
  }

  private liveHandles(): CliTool[] {
    return [...this.handles].filter(([id]) => this.d.live?.(this.owners.get(id) ?? '') !== false).map(([, h]) => h)
  }
}

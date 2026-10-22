// Cleaner: what `/track clean` does with the `cleanup` part of the trackers (issue #122, phase P2 of #49). `plan` asks each
// live tracker, in `order`, what a cleanup would do: it reads the view and runs nothing. `apply` asks again, takes the
// steps of the named kinds that have no reason to be skipped, hands them to their tracker and keeps one entry in the audit
// log for each step it tried. A tracker that throws loses its own steps and is named; the others go on. It names no tracker.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design study: issue #49, sections 5.3 to 5.5.

import type { CleanKind, CleanResult, CleanStep, LogEntry } from '../interfaces/clean'
import type { Ports } from '../interfaces/ports'
import type { Tracker } from '../interfaces/tracker'
import type { Line } from '../lib/clean-text'
import type { Persistence } from './persistence'
import { reason } from './steps'
import type { TrackerHost } from './tracker-host'
import type { Views } from './views'

/** The longest id or outcome the audit log keeps. A command line never goes in: the entry has no label. */
const MAX_LOGGED = 200

const clip = (text: string): string => (text.length > MAX_LOGGED ? `${text.slice(0, MAX_LOGGED - 1)}…` : text)

export interface CleanerDeps {
  trackers: readonly Tracker[]
  /** Which trackers run, and the context `apply` runs in. */
  host: Pick<TrackerHost, 'live' | 'ctx'>
  /** The read-only context `plan` reads. */
  views: Pick<Views, 'viewsOf'>
  /** The audit log. Persistence is the only writer of the store. */
  persistence: Pick<Persistence, 'appendLog' | 'readLog'>
  log(line: string): void
}

/** What `plan` and `apply` give: the lines, in the order of the trackers, and the trackers that failed. */
export interface CleanRun {
  readonly lines: readonly Line[]
  /** One line for each tracker whose plan or apply could not run, e.g. `auto: plan failed: boom`. */
  readonly failed: readonly string[]
}

type Planned = { readonly t: Tracker; readonly steps: readonly CleanStep[] }

export class Cleaner {
  private readonly ordered: readonly Tracker[]

  constructor(private readonly d: CleanerDeps) {
    this.ordered = [...d.trackers].sort((a, b) => a.order - b.order)
  }

  /** What a cleanup would do. Reads only: no slot write, no store write, no process. */
  async plan(p: Ports): Promise<CleanRun> {
    const { planned, failed } = await this.planned(p)
    return { lines: planned.flatMap(x => x.steps.map(step => ({ step }))), failed }
  }

  /**
   * Applies the steps of `kinds`. A step with a reason is listed as skipped and never tried. The others go to their
   * tracker, which answers each. Every step that was tried is one entry in the audit log, with its outcome.
   */
  async apply(p: Ports, kinds: readonly CleanKind[]): Promise<CleanRun> {
    const { planned, failed } = await this.planned(p)
    const lines: Line[] = []
    const entries: LogEntry[] = []
    const at = p.clock.wall()
    for (const { t, steps } of planned) {
      const chosen = steps.filter(s => kinds.includes(s.kind))
      const tried = chosen.filter(s => s.skip === undefined)
      const results = tried.length > 0 ? await this.run(p, t, tried, failed) : new Map<string, string>()
      for (const step of chosen) {
        if (step.skip !== undefined) {
          lines.push({ step, outcome: `skipped: ${step.skip}` })
          continue
        }
        const outcome = results.get(step.id) ?? 'skipped: no result'
        lines.push({ step, outcome })
        entries.push({
          at,
          by: 'manual',
          kind: step.kind,
          id: clip(step.id),
          action: step.action,
          outcome: clip(outcome),
        })
      }
    }
    await this.d.persistence.appendLog(entries)
    return { lines, failed }
  }

  /** The audit log, newest first. */
  history(): Promise<readonly LogEntry[]> {
    return this.d.persistence.readLog()
  }

  /** The outcome of each tried step by its id. A tracker that throws gives every step `skipped: <message>`, and is named. */
  private async run(p: Ports, t: Tracker, tried: readonly CleanStep[], failed: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    try {
      const results: readonly CleanResult[] = (await t.cleanup?.apply(this.d.host.ctx(t.id, p), tried)) ?? []
      for (const r of results) out.set(r.id, r.outcome)
    } catch (e) {
      this.d.log(`clean: apply of ${t.id} failed: ${reason(e)}`)
      failed.push(`${t.id}: apply failed: ${reason(e)}`)
      for (const s of tried) out.set(s.id, `skipped: ${reason(e)}`)
    }
    return out
  }

  /** The steps of each live tracker that has a cleanup, over one read of the state. A tracker whose plan throws is named. */
  private async planned(p: Ports): Promise<{ planned: Planned[]; failed: string[] }> {
    const owners = this.ordered.filter(t => t.cleanup !== undefined && this.d.host.live(t.id))
    const views = await this.d.views.viewsOf(
      p,
      owners.map(t => t.id),
    )
    const planned: Planned[] = []
    const failed: string[] = []
    owners.forEach((t, i) => {
      try {
        planned.push({ t, steps: t.cleanup?.plan(views[i] as NonNullable<(typeof views)[number]>) ?? [] })
      } catch (e) {
        this.d.log(`clean: plan of ${t.id} failed: ${reason(e)}`)
        failed.push(`${t.id}: plan failed: ${reason(e)}`)
      }
    })
    return { planned, failed }
  }
}

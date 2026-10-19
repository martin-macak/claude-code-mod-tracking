// Views: what the pane, the band and the `/track` text draw from. The manager reads the state once, builds a ViewContext
// per tracker and asks each live tracker for its sections. It only reads: no session check, no write, so a render may
// call it (E8, E9). The trackers draw themselves; this holds only the order of the sections and the read.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, K1, K2; L6 A2, A3, A5.

import type { ConfigSource } from '../interfaces/config'
import type { Effective, Json, StoredItem } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DismissPort, FactsPort, ToolStatus, Tracker } from '../interfaces/tracker'
import type { PaneView, SectionSpec, ViewContext } from '../interfaces/view'
import { isRecord } from '../lib/json'
import { reason } from './steps'

/** The view of a pane nobody touched: nothing selected, nothing opened. */
export const NO_VIEW: PaneView = { selected: null, expanded: new Set() }

/**
 * The sections in the order of the pane or of the band. The pane places a section by its `rank`, else by the `order` of
 * its tracker. The band places a part by `band.rank`, else the section's `rank`, else the `order`. A tie keeps the
 * order of the input.
 */
export function sortSections(list: readonly { s: SectionSpec; order: number }[], by: 'pane' | 'band'): SectionSpec[] {
  const place = ({ s, order }: { s: SectionSpec; order: number }): number =>
    by === 'band' ? (s.band?.rank ?? s.rank ?? order) : (s.rank ?? order)
  return [...list].sort((a, b) => place(a) - place(b)).map(x => x.s)
}

/** What every tracker of one call reads alike: one read of the atoms, the dismiss list and the levels. */
export interface ViewRead {
  /** Epoch ms. */
  now: number
  /** The items of the trackers that are on. */
  items: readonly StoredItem[]
  tools: Readonly<Record<string, ToolStatus>>
  dismissed: ReadonlySet<string>
  levels: ReadonlyMap<string, Effective>
}

export interface ViewsDeps {
  trackers: readonly Tracker[]
  config: ConfigSource
  facts: FactsPort
  /** The run-scoped dismiss list over the ports of a call. */
  dismiss(ports: Ports): DismissPort
  /** The levels of a list of items: the person's marks, then the rules of the kinds. */
  levels(items: readonly StoredItem[]): Promise<ReadonlyMap<string, Effective>>
  /** False for a tracker the config turned off, or that failed to start. */
  live(id: string): boolean
  log(line: string): void
}

/**
 * One read of the state for every tracker of a call: the atoms, the dismiss list and the levels. An item of a tracker
 * that is off is left out, and so is its level.
 */
export async function readView(ports: Ports, d: ViewsDeps): Promise<ViewRead> {
  const owners = new Map<string, string>()
  for (const t of d.trackers) for (const k of t.kinds ?? []) if (!owners.has(k.category)) owners.set(k.category, t.id)
  const [all, tools, dismissed] = await Promise.all([
    ports.state.items.get(),
    ports.state.tools.get(),
    d.dismiss(ports).list(),
  ])
  const items = all.filter(i => {
    const owner = owners.get(i.category)
    return owner === undefined || d.live(owner)
  })
  return { now: ports.clock.wall(), items, tools, dismissed, levels: await d.levels(items) }
}

/** The root the session is pinned to: the `cwd` of the fact `auto.root`. */
function rootOf(facts: Pick<FactsPort, 'read'>): string | undefined {
  const root = facts.read('auto.root')
  return isRecord(root) && typeof root.cwd === 'string' ? root.cwd : undefined
}

export class Views {
  private readonly ordered: readonly Tracker[]

  constructor(private readonly d: ViewsDeps) {
    this.ordered = [...d.trackers].sort((a, b) => a.order - b.order)
  }

  /** The level of every item, by key. */
  async levels(ports: Ports): Promise<ReadonlyMap<string, Effective>> {
    return (await readView(ports, this.d)).levels
  }

  /** The context a tracker draws from, over a read. `data` is the tracker's slot. */
  private contextOf(t: Tracker, read: ViewRead, view: PaneView, data: Json | undefined): ViewContext {
    const { facts, config } = this.d
    return {
      now: read.now,
      config: { slice: () => config.slice(t.id), global: () => config.global() },
      data,
      items: read.items,
      facts: { read: <T extends Json>(name: string) => facts.read<T>(name) },
      tools: read.tools,
      selected: view.selected,
      expanded: view.expanded,
      root: rootOf(facts),
      isDismissed: id => read.dismissed.has(id),
      levelOf: key => read.levels.get(key) ?? {},
    }
  }

  /** The context of one tracker. A tracker no list holds is an error. */
  async viewOf(ports: Ports, owner: string, view: PaneView = NO_VIEW): Promise<ViewContext> {
    const t = this.ordered.find(x => x.id === owner)
    if (!t) throw new Error(`views: no tracker ${owner}`)
    const [read, data] = await Promise.all([readView(ports, this.d), ports.state.slot.get(owner)])
    return this.contextOf(t, read, view, data)
  }

  /** The sections of the live trackers that draw any, in the order of the pane. */
  async paneData(ports: Ports, view: PaneView): Promise<readonly SectionSpec[]> {
    return sortSections(await this.collect(ports, view), 'pane')
  }

  /** The sections that carry a band part, in the order of the band. */
  async bandData(ports: Ports): Promise<readonly SectionSpec[]> {
    return sortSections(
      (await this.collect(ports, NO_VIEW)).filter(x => x.s.band !== undefined),
      'band',
    )
  }

  /** Asks each live tracker, in `order`. A tracker that throws loses its own sections and is logged. */
  private async collect(ports: Ports, view: PaneView): Promise<{ s: SectionSpec; order: number }[]> {
    const drawing = this.ordered.filter(t => t.sections !== undefined && this.d.live(t.id))
    const [read, data] = await Promise.all([
      readView(ports, this.d),
      Promise.all(drawing.map(t => ports.state.slot.get(t.id))),
    ])
    const out: { s: SectionSpec; order: number }[] = []
    drawing.forEach((t, i) => {
      try {
        for (const s of t.sections?.(this.contextOf(t, read, view, data[i])) ?? []) out.push({ s, order: t.order })
      } catch (e) {
        this.d.log(`views: sections of ${t.id} failed: ${reason(e)}`)
      }
    })
    return out
  }
}

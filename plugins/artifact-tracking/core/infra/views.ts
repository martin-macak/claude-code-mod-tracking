// Views: what the pane, the band and the `/track` text draw from. The manager reads the state once, builds a ViewContext
// per tracker and asks each live tracker for its sections. It only reads: no session check, no write, so a render may
// call it (E8, E9). The trackers draw themselves; this holds only the order of the sections and the read.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, K1, K2; L6 A2, A3, A5.

import type { ConfigSource } from '../interfaces/config'
import type { Effective, Json, StoredItem } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DismissPort, FactsPort, ToolStatus, Tracker } from '../interfaces/tracker'
import type { HiddenState, PaneView, SectionSpec, ViewContext } from '../interfaces/view'
import { isRecord } from '../lib/json'
import { hasTurns } from '../lib/reasons'
import { type TurnLookup, turnSpans, withTurns } from '../lib/rows'
import { reason } from './steps'

/** The view of a pane nobody touched: nothing selected, nothing opened. */
export const NO_VIEW: PaneView = { selected: null, expanded: new Set() }

/** `/track show-all` on, with no `--hide` sweep: every tracker lets every row pass. */
const SHOW_ALL: HiddenState = { showAll: true }

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

/**
 * The sections that carry a band part, in the order of the band, from sections that are already read (issue #138): the summary row
 * of the pane takes the words of the band from the sections a drawing holds, with no second pass over the trackers. The list is in
 * pane order, so a section with neither a band rank nor a rank takes its place in it, where `bandData` takes the order of its
 * tracker. Every section with a band part sets both ranks today (see the `sections.ts` of each tracker), so the two never differ.
 */
export function bandSections(sections: readonly SectionSpec[]): SectionSpec[] {
  return sortSections(
    sections.flatMap((s, order) => (s.band === undefined ? [] : [{ s, order }])),
    'band',
  )
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
  /** `/track show-all`: read once, so every tracker of the call hides, or shows, alike. */
  hidden: HiddenState
  /** The home folder: `HOME` when absolute, else undefined (none, empty, relative, or the read is refused). */
  home: string | undefined
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
 * `HOME`, or undefined when it is empty, relative, the engine has none or it refuses the read. A relative value would
 * shorten a relative word to a wrong `~/`, so only an absolute path counts: it starts with `/` or `\`, or with a drive
 * letter (`C:`). The home folder is display only.
 */
async function homeOf(ports: Ports): Promise<string | undefined> {
  try {
    const home = await ports.env.get('HOME')
    return home && /^([A-Za-z]:)?[\\/]/.test(home) ? home : undefined
  } catch {
    return undefined
  }
}

/**
 * One read of the state for every tracker of a call: the atoms, the dismiss list and the levels. An item of a tracker
 * that is off is left out, and so is its level.
 */
export async function readView(ports: Ports, d: ViewsDeps): Promise<ViewRead> {
  const owners = new Map<string, string>()
  for (const t of d.trackers) for (const k of t.kinds ?? []) if (!owners.has(k.category)) owners.set(k.category, t.id)
  const [all, tools, dismissed, hidden, home] = await Promise.all([
    ports.state.items.get(),
    ports.state.tools.get(),
    d.dismiss(ports).list(),
    ports.state.hidden.get(),
    homeOf(ports),
  ])
  const items = all.filter(i => {
    const owner = owners.get(i.category)
    return owner === undefined || d.live(owner)
  })
  return { now: ports.clock.wall(), items, tools, dismissed, hidden, home, levels: await d.levels(items) }
}

/** The root the session is pinned to: the `cwd` of the fact `auto.root`. */
function rootOf(facts: Pick<FactsPort, 'read'>): string | undefined {
  const root = facts.read('auto.root')
  return isRecord(root) && typeof root.cwd === 'string' ? root.cwd : undefined
}

const noTracker = (id: string): never => {
  throw new Error(`views: no tracker ${id}`)
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
      home: read.home,
      hidden: read.hidden,
      isDismissed: id => read.dismissed.has(id),
      levelOf: key => read.levels.get(key) ?? {},
    }
  }

  /** The contexts of some trackers, in the order asked, over one read. A tracker no list holds is an error. */
  async viewsOf(ports: Ports, owners: readonly string[], view: PaneView = NO_VIEW): Promise<ViewContext[]> {
    const found = owners.map(id => this.ordered.find(t => t.id === id) ?? noTracker(id))
    const slots = Promise.all(found.map(t => ports.state.slot.get(t.id)))
    const [read, data] = await Promise.all([readView(ports, this.d), slots])
    return found.map((t, i) => this.contextOf(t, read, view, data[i]))
  }

  /** The context of one tracker. */
  async viewOf(ports: Ports, owner: string, view: PaneView = NO_VIEW): Promise<ViewContext> {
    return (await this.viewsOf(ports, [owner], view))[0] as ViewContext
  }

  /** The sections of the live trackers that draw any, in the order of the pane. */
  async paneData(ports: Ports, view: PaneView): Promise<readonly SectionSpec[]> {
    return sortSections(await this.collect(ports, view), 'pane')
  }

  /**
   * The sections of the live trackers with no row left out for a rule of time or of a cap. Each such rule reads
   * `ViewContext.hidden.showAll`, and the inventory sets it: the TTL of an ended row, the row cap and `/track clean --hide`
   * let every row pass. A row that is still left out is gone: a dismissed row, or one no tracker holds any more. The next
   * mark write prunes by it (issue #138): a mark ends with its row, never because the pane hides the row for now. It reads
   * like `paneData` and writes nothing.
   */
  async inventory(ports: Ports): Promise<readonly SectionSpec[]> {
    return (await this.collect(ports, NO_VIEW, SHOW_ALL)).map(x => x.s)
  }

  /** The sections that carry a band part, in the order of the band. */
  async bandData(ports: Ports): Promise<readonly SectionSpec[]> {
    return sortSections(
      (await this.collect(ports, NO_VIEW)).filter(x => x.s.band !== undefined),
      'band',
    )
  }

  /**
   * Asks each live tracker, in `order`. A tracker that throws loses its own sections and is logged. `hidden` replaces the
   * session's `/track show-all` and `--hide` state for this one call.
   */
  private async collect(
    ports: Ports,
    view: PaneView,
    hidden?: HiddenState,
  ): Promise<{ s: SectionSpec; order: number }[]> {
    const drawing = this.ordered.filter(t => t.sections !== undefined && this.d.live(t.id))
    const [seen, data] = await Promise.all([
      readView(ports, this.d),
      Promise.all(drawing.map(t => ports.state.slot.get(t.id))),
    ])
    const read = hidden === undefined ? seen : { ...seen, hidden }
    const out: { s: SectionSpec; order: number }[] = []
    // The first and the last turn of each item go on its row (issue #69), so no kind draws them. A slot tracker that has
    // `turnsOf` (issue #133) gives the turns of its own rows; the rest of the trackers have none.
    const spans = turnSpans(read.items)
    drawing.forEach((t, i) => {
      try {
        const own = this.lookupOf(t, data[i])
        for (const s of t.sections?.(this.contextOf(t, read, view, data[i])) ?? [])
          out.push({
            s: spans.size === 0 && own === undefined ? s : { ...s, rows: withTurns(s.rows, spans, own) },
            order: t.order,
          })
      } catch (e) {
        this.d.log(`views: sections of ${t.id} failed: ${reason(e)}`)
      }
    })
    return out
  }

  /**
   * The turns of the rows of one tracker, from its `turnsOf` over its slot. undefined: the tracker has none. A `turnsOf` that
   * throws loses the turns of that row and is logged: the section still draws.
   */
  private lookupOf(t: Tracker, data: Json | undefined): TurnLookup | undefined {
    if (!hasTurns(t)) return undefined
    return rowId => {
      try {
        return t.turnsOf(data, rowId)
      } catch (e) {
        this.d.log(`views: turnsOf of ${t.id} failed: ${reason(e)}`)
        return undefined
      }
    }
  }
}

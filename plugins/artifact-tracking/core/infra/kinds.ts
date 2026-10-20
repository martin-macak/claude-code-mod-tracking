// Kinds: the item kinds of the trackers of a load, who owns each, which are live, and the context each is given. A kind is
// a module constant, so everything per load lives here. It names no kind and holds no `$`.
// A kind of a tracker that is off still claims its spans (so a URL never falls to a later kind) but never prepares,
// accepts, restores or reads a tool.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.9. Plan: L5 Task 8, K9, K21.

import type { ConfigSource } from '../interfaces/config'
import type {
  HostContext,
  ItemKind,
  ItemStorePort,
  Json,
  JsonObject,
  KindContext,
  PrepareContext,
  ScanMode,
  StoredItem,
} from '../interfaces/items'
import type { KindReason } from '../interfaces/reasons'
import type { FactsPort, ToolPort, Tracker } from '../interfaces/tracker'
import { scanContext } from '../lib/kind-context'
import { checkKindReasons } from '../lib/reasons'
import type { KindTable } from '../lib/records'

export interface KindsDeps {
  trackers: readonly Tracker[]
  /** False for a tracker the config turned off, or that failed to start. */
  live(owner: string): boolean
  config: ConfigSource
  facts: FactsPort
  /** The context of the first hook of the load. undefined before the start. */
  host(): HostContext | undefined
  /** The tools of one tracker. undefined before the tools are built. */
  tools(owner: string): ToolPort | undefined
  /** What a `prepare` may write: the raw writer, because a prepare also runs inside a session switch. */
  items: Pick<ItemStorePort, 'update' | 'refresh'>
}

/** What a context needs besides the kind: where the text came from and how it is read. */
export type ContextOptions = {
  source: string
  mode: ScanMode
  purpose: 'capture' | 'lookup'
  agentId?: string | undefined
  cwdBefore?: string | undefined
  /** The context of one dispatch: its own ports. Default: the context of the first hook of the load. */
  host?: HostContext | undefined
  /** Facts that win over the real ones for this call. */
  facts?: Readonly<Record<string, Json>> | undefined
}

export class Kinds {
  /** Every kind of every tracker, by rank. A category kept once: the first tracker's. */
  readonly all: readonly ItemKind[]
  private readonly owners = new Map<string, Tracker>()
  private readonly reasons: ReturnType<typeof checkKindReasons>

  constructor(private readonly d: KindsDeps) {
    const seen = new Map<string, ItemKind>()
    for (const t of d.trackers)
      for (const kind of t.kinds ?? []) {
        if (seen.has(kind.category)) continue
        seen.set(kind.category, kind)
        this.owners.set(kind.category, t)
      }
    this.all = [...seen.values()].sort((a, b) => a.rank - b.rank)
    // An unmapped or a repeated reason of a kind is dropped here, when the kinds are collected, and reported as a problem,
    // like a key that is taken (KeyRegistry). A faulty kind never stops the others, or the mod.
    this.reasons = checkKindReasons(this.all)
  }

  /** One line for each kind reason that is off: unmapped, repeated, or clashing with another kind. */
  problems(): readonly string[] {
    return this.reasons.problems
  }

  /** The reasons a kind adds that passed the check, in the order it declared them. A word that is off is not in it. */
  kindReasons(category: string): readonly KindReason[] {
    return this.reasons.kept.get(category) ?? []
  }

  /** The kind of a category, or undefined. */
  readonly table: KindTable = category => this.all.find(kind => kind.category === category)

  /** True when the tracker of the category is on. A category no kind owns reads as live: nothing turned it off. */
  isLive(category: string): boolean {
    const owner = this.owners.get(category)
    return owner === undefined || this.d.live(owner.id)
  }

  /** The kinds of the trackers that are on, by rank. */
  liveKinds(): ItemKind[] {
    return this.all.filter(kind => this.isLive(kind.category))
  }

  /** The records of the kinds that are on. The same array when none is dropped. */
  onlyOn<T extends Pick<StoredItem, 'category'>>(list: T[]): T[] {
    const kept = list.filter(rec => this.isLive(rec.category))
    return kept.length === list.length ? list : kept
  }

  /** True when a kind reads the tool. Static: it needs no start. */
  wants(tool: string): boolean {
    return this.all.some(kind => this.reader(kind, tool) !== undefined)
  }

  /** What `kind` is given with a text: the config of its tracker, its tools, the facts, and the ports of the dispatch. */
  context(kind: ItemKind, o: ContextOptions): KindContext {
    const tracker = this.owners.get(kind.category)
    const owner = tracker?.id ?? kind.category
    const plain = this.plain(o)
    return {
      ...plain,
      // The slice comes over the defaults of the tracker's spec: a host with no spec for it reads today's numbers.
      config: {
        slice: () => ({ ...tracker?.config.defaults, ...this.d.config.slice(owner) }) as JsonObject,
        global: () => this.d.config.global(),
      },
      tools: this.d.tools(owner) ?? plain.tools,
      // Only the words that passed the check: a kind that lost a clash cannot claim its core reason through its own list.
      kindReasons: this.kindReasons(kind.category),
    }
  }

  /** A context for no kind in particular (a lookup): the facts and the ports, an empty slice, the raw run. */
  plain(o: ContextOptions): KindContext {
    const host = o.host ?? this.d.host()
    const real = this.d.facts
    const facts: Pick<FactsPort, 'read'> = o.facts
      ? {
          read: <T extends Json>(name: string) =>
            (Object.hasOwn(o.facts!, name) ? o.facts![name] : real.read(name)) as T,
        }
      : real
    const inert = scanContext({ mode: o.mode, purpose: o.purpose, source: o.source })
    return {
      ...inert,
      now: host?.clock.wall() ?? 0,
      ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
      ...(o.cwdBefore !== undefined ? { cwdBefore: o.cwdBefore } : {}),
      config: { slice: () => ({}), global: () => this.d.config.global() },
      facts,
      ...(host
        ? {
            tools: { handle: () => undefined, run: host.tools.run },
            fs: host.fs,
            env: host.env,
            session: host.session,
            clock: host.clock,
            log: host.log,
          }
        : {}),
    }
  }

  /** What a live kind reads of a tool call, or undefined. A tool name is data: only an own key of `fromTool` counts. */
  reader(kind: ItemKind, tool: string): NonNullable<ItemKind['fromTool']>[string] | undefined {
    return kind.fromTool && Object.hasOwn(kind.fromTool, tool) ? kind.fromTool[tool] : undefined
  }

  /** The context of a `prepare` or a `sessionChanged`: the facts it may publish and the store it may write. */
  prepareContext(kind: ItemKind, host?: HostContext): PrepareContext {
    return {
      ...this.context(kind, { source: 'prepare', mode: 'full', purpose: 'capture', host }),
      facts: this.d.facts,
      items: this.d.items,
    }
  }

  /**
   * Runs the `prepare` of every live kind. `wait: false` starts them and returns (a load gives the lookups a head
   * start). `quick: true` waits only for the cheap part of each (a replay). A prepare writes through the raw writer
   * only: it also runs inside a switch, which holds the session check.
   */
  async prepare(o: { wait: boolean; quick?: boolean } = { wait: true }): Promise<void> {
    if (!this.d.host()) return
    const quick = o.quick === true
    const run = (async () => {
      await Promise.all(this.liveKinds().map(kind => kind.prepare?.(this.prepareContext(kind), { quick })))
    })()
    if (o.wait) await run
    else run.catch(() => {})
  }
}

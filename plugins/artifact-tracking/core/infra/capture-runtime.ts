// Capture: the five steps of spec 5.9 for one text. It waits for the live kinds to prepare (a replay waits for the quick
// part only), scans the text with every kind (a kind that is off still claims its spans), then lets each live kind
// accept its own claims. It returns the claims; the ItemStore merges them and drops the claims of a kind that is off. It
// names no kind and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 8, K21.

import type { ReplayItem, RowEvent, ToolCallEvent } from '../interfaces/events'
import type { Claim, HostContext, ItemKind, Json, ScanMode } from '../interfaces/items'
import { isRecord } from '../lib/json'
import { scanClaims } from './capture'
import { readingOf } from './doors'
import type { Kinds } from './kinds'
import { reason } from './steps'

export class Capture {
  constructor(
    private readonly kinds: Kinds,
    private readonly log: (line: string) => void,
  ) {}

  /** The claims of one row, by the rules of its door. `quick`: see `text`. */
  async row(ev: RowEvent, o: { quick?: boolean } = {}): Promise<Claim[]> {
    const read = readingOf(ev)
    if (!read) return []
    return this.text(read.text, read.mode, read.source, {
      ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}),
      ...(o.quick ? { quick: true } : {}),
    })
  }

  /**
   * The claims in a text: prepare, scan with every kind, accept. An empty text gives none. `quick` is for a replay: the
   * kinds finish only the cheap part of their prepare, so a load never waits for a CLI (finding the repo from the git
   * remote is quick, a call to a CLI is not). The scan then reads what the kinds know by now.
   */
  async text(
    text: string,
    mode: ScanMode,
    source: string,
    o: { agentId?: string; quick?: boolean } = {},
  ): Promise<Claim[]> {
    if (text === '') return []
    await this.kinds.prepare({ wait: true, quick: o.quick === true })
    const context = (kind: ItemKind) =>
      this.kinds.context(kind, { source, mode, purpose: 'capture', agentId: o.agentId })
    return this.accept(scanClaims(text, mode, this.kinds.all, context), context)
  }

  /**
   * The claims in a text, of the live kinds, by the rules of `o`. Every kind scans (a kind that is off still claims its
   * spans, so a URL never falls to a later kind), then the claims of a kind that is off go. Nothing is prepared or
   * accepted; the source is `scan`.
   */
  scan(
    text: string,
    o: { mode: ScanMode; purpose: 'capture' | 'lookup'; facts?: Readonly<Record<string, Json>> },
  ): readonly Claim[] {
    const found = scanClaims(text, o.mode, this.kinds.all, kind =>
      this.kinds.context(kind, { source: 'scan', mode: o.mode, purpose: o.purpose, facts: o.facts }),
    )
    return found.filter(c => this.kinds.isLive(c.category))
  }

  /**
   * The claims of a transcript read back, in transcript order: the rows, the tool calls, and the text of each tool use
   * (explicit URLs only, as for a live tool-result row). A use carries its whole self as `ev.result`. The kinds prepare
   * quickly: a replay runs inside a session load or switch and must not wait for a CLI. One exception: a kind may need
   * the answer of its tool to accept a claim (`accept`) or to read a tool use (`fromTool`), and a transcript with such a
   * use waits for it. The kind that does it shares one lookup between the callers that ask at once and bounds it by the tool
   * timeout and the breaker. A site or a "not logged in" answer is cached; a lookup that fails for another reason is asked
   * again until the breaker opens. A replayed command that may change the account makes the kind forget its answer, so a
   * later use in the same transcript asks again.
   */
  async replay(batch: readonly ReplayItem[]): Promise<Claim[]> {
    const claims: Claim[] = []
    for (const item of batch) {
      if (item.kind === 'row') {
        claims.push(...(await this.row(item.ev, { quick: true })))
        continue
      }
      claims.push(...(await this.toolCall(item.ev)))
      const use = item.ev.result
      const text = isRecord(use) && typeof use.text === 'string' ? use.text : ''
      if (text) claims.push(...(await this.text(text, 'urls-only', 'tool', { quick: true })))
    }
    return claims
  }

  /** The claims one live kind makes of a tool call, accepted. `host`: the context of the dispatch. */
  async fromTool(kind: ItemKind, ev: ToolCallEvent, host?: HostContext): Promise<Claim[]> {
    const read = this.kinds.reader(kind, ev.tool)
    if (!read) return []
    const context = (k: ItemKind) =>
      this.kinds.context(k, {
        source: 'tool',
        mode: 'full',
        purpose: 'capture',
        agentId: ev.agentId,
        cwdBefore: ev.cwdBefore,
        host,
      })
    return this.accept([...(await read(ev, context(kind)))], context, [kind])
  }

  /** The claims of every live kind that reads the tool. A kind that throws gives none; the others still count. */
  async toolCall(ev: ToolCallEvent, host?: HostContext): Promise<Claim[]> {
    const out: Claim[] = []
    for (const kind of this.kinds.liveKinds()) {
      if (!this.kinds.reader(kind, ev.tool)) continue
      try {
        out.push(...(await this.fromTool(kind, ev, host)))
      } catch {
        // One kind's fault must not hide the rest of the batch.
      }
    }
    return out
  }

  /**
   * Each live kind filters its own claims. Claims of a kind with no `accept` pass. The result keeps no order across kinds.
   * A kind whose `accept` throws loses its own claims and says so in the log; the claims of the other kinds still count
   * (a fault in one kind must not hide the refs of the other kinds in the same row).
   */
  private async accept(
    claims: Claim[],
    context: (kind: ItemKind) => ReturnType<Kinds['context']>,
    among: readonly ItemKind[] = this.kinds.liveKinds(),
  ): Promise<Claim[]> {
    let out = claims
    for (const kind of among) {
      if (!kind.accept) continue
      const own = out.filter(c => c.category === kind.category)
      if (own.length === 0) continue
      let kept: readonly Claim[] = []
      try {
        kept = await kind.accept(own, context(kind))
      } catch (e) {
        this.log(`items: accept failed in ${kind.category}: ${reason(e)}`)
      }
      out = [...out.filter(c => c.category !== kind.category), ...kept]
    }
    return out
  }
}

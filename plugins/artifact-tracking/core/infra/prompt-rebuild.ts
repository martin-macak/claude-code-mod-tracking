// PromptRebuild: when the prompt text is rebuilt and what it is built from. It owns the PromptComposer of one load. The
// text is rebuilt eagerly, with the ports of a normal hook, at the start, after a session switch, at the end of a
// main-loop turn, when the config file changed and when the person dismisses an item, clears the list or marks a
// priority (S1, S2, S14).
// `compose` only reads memory: it takes no ports, writes no state and never rebuilds, so the one `prompt.compose` hook
// needs no engine call. A data change alone does not rebuild, because a changed text would rewrite the prompt cache in
// the middle of a turn.
// A source is a live tracker that defines `prompt`, is on in the config and has `prompt.enabled`. The views of all the
// sources are read once per rebuild (S15): a failing read keeps the old text, and the next boundary tries again. A
// throwing `prompt` skips only that tracker. It names no tracker and holds no engine API.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 6 (S1, S2, S12).

import type { ConfigSource } from '../interfaces/config'
import type { TurnCompleteEvent } from '../interfaces/events'
import type { Ports } from '../interfaces/ports'
import type { PromptRequest, PromptSection, PromptSource } from '../interfaces/prompt'
import type { Tracker } from '../interfaces/tracker'
import type { ViewContext } from '../interfaces/view'
import { isRecord } from '../lib/json'
import { promptSettings } from '../lib/prompt-config'
import { PromptComposer } from './prompt'
import { reason } from './steps'

/** What the rebuild reads of the manager, at call time: the config, which trackers run, and the views of some of them. */
export interface PromptOwner {
  readonly config: ConfigSource
  live(id: string): boolean
  /** The views of the trackers, in the order asked, over one read of the state. */
  viewsOf(ports: Ports, owners: readonly string[]): Promise<readonly ViewContext[]>
}

/** A turn that a subagent ended carries its `agentId`. The main loop's turn carries none. */
const fromSubagent = ({ input }: TurnCompleteEvent): boolean =>
  isRecord(input) && typeof input.agentId === 'string' && input.agentId !== ''

export class PromptRebuild {
  private readonly composer: PromptComposer
  /** The trackers that can list items, in `order`. */
  private readonly askable: readonly Tracker[]

  constructor(
    private readonly owner: PromptOwner,
    private readonly d: { trackers: readonly Tracker[]; log(line: string): void },
  ) {
    this.composer = new PromptComposer(d)
    this.askable = d.trackers.filter(t => t.prompt !== undefined).sort((a, b) => a.order - b.order)
  }

  /** The list with our section last. Sync, reads memory only. A failure returns the list as it came and is logged. */
  compose(req: PromptRequest, sections: readonly PromptSection[]): readonly PromptSection[] {
    try {
      return this.composer.compose(req, sections)
    } catch (e) {
      this.d.log(`prompt: compose failed: ${reason(e)}`)
      return sections
    }
  }

  /** Rebuilds the text. A call during a build shares that build (see PromptComposer). Never rejects. */
  async rebuild(ports: Ports): Promise<void> {
    await this.composer.rebuild(() => this.sources(ports))
  }

  /** The end of a main-loop turn is a boundary. A subagent's turn is not: its items reach the next main-loop turn. */
  async afterTurn(ports: Ports, ev: TurnCompleteEvent): Promise<void> {
    if (!fromSubagent(ev)) await this.rebuild(ports)
  }

  /** `session.end`: the text belongs to the session that left. */
  reset(): void {
    this.composer.reset()
  }

  /** Wraps the config refresh: a change rebuilds at once, so a flipped switch needs no turn (Review Focus 5). */
  afterRefresh(refresh: (ports: Ports) => Promise<boolean>): (ports: Ports) => Promise<boolean> {
    return async ports => {
      const changed = await refresh(ports)
      if (changed) await this.rebuild(ports)
      return changed
    }
  }

  /** One source per live tracker that opted in, over one read of the state. With none on, nothing is read. */
  private async sources(ports: Ports): Promise<readonly PromptSource[]> {
    const on = this.askable.flatMap(t => {
      const settings = this.owner.live(t.id) ? promptSettings(this.owner.config.slice(t.id)) : undefined
      return settings?.enabled ? [{ t, settings }] : []
    })
    if (on.length === 0) return []
    const views = await this.owner.viewsOf(
      ports,
      on.map(({ t }) => t.id),
    )
    return on.map(({ t, settings }, i) => ({
      id: t.id,
      settings,
      lines: async () => t.prompt?.(views[i] as ViewContext) ?? [],
    }))
  }
}

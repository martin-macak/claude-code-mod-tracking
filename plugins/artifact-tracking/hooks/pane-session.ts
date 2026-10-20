// PaneSession: what the pane keeps for one load outside the engine state: the last drawing (its handle map and rows), a
// refocus that waits for its element (pane-refocus.ts), and the work behind each Button. `draw` only reads (E9). The
// writes run from the Buttons and from the focus and close hooks. register.tsx calls it; nothing here touches the engine.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G6, G8, G22.

import type { RenderElement } from 'claude-code'
import { route } from '../core/infra/keys'
import { reason } from '../core/infra/steps'
import type { Ports } from '../core/interfaces/ports'
import type { SectionSpec } from '../core/interfaces/view'
import { resetWidths } from '../ux/tree-data-table/columns'
import type { TableElements } from '../ux/tree-data-table/el'
import {
  type Drawn,
  findRow,
  neighbourOf,
  type TableActions,
  type TableView,
  TreeDataTable,
} from '../ux/tree-data-table/table'
import { WorkQueue } from './pane-queue'
import { Refocus } from './pane-refocus'
import { helpOf, type PaneHost, shownOf } from './pane-text'

export { helpOf, helpTextOf, listText, type PaneHost, TEXT_VIEW } from './pane-text'

export class PaneSession {
  private drawn: Drawn | undefined
  private sections: readonly SectionSpec[] = []
  private readonly refocus = new Refocus()
  private readonly work = new WorkQueue()

  /** Reads the state and the sections, and draws. It writes nothing and calls no entry (E9). */
  async draw(
    p: Ports,
    m: PaneHost,
    el: TableElements,
    bodyColumns: number | undefined,
    bodyRows?: number,
  ): Promise<RenderElement> {
    const [expanded, selected, help] = await Promise.all([
      p.state.expanded.get(),
      p.state.selected.get(),
      p.state.help.get(),
    ])
    const sections = await m.paneData(p, { selected, expanded: new Set(expanded) })
    const shown = await shownOf(p, sections)
    const view: TableView = {
      bodyColumns,
      bodyRows,
      selected,
      expanded: new Set(expanded),
      shown: id => shown.get(id) ?? 0,
      limits: m.config.global().ui,
      footer: await m.footer(p, findRow(sections, selected), help),
      help: help ? helpOf(m, sections) : null,
    }
    const drawn = TreeDataTable.render(sections, view, el, this.actionsOf(p, m))
    this.refocus.seen(drawn)
    this.drawn = drawn
    this.sections = sections
    return drawn.tree
  }

  /**
   * The engine moved the ring to `element`. A row handle selects its row: the pending refocus answers its own key once,
   * else the last drawing does. A footer key, an "N more" row, the close mark and no element leave the selection alone.
   */
  async focused(p: Ports, element: string | undefined): Promise<void> {
    try {
      if (element === undefined) return
      const id = this.refocus.take(element) ?? this.drawn?.handles.get(element)
      if (id !== undefined) await p.state.selected.update(() => id)
    } catch (e) {
      p.log(`pane: focus failed: ${reason(e)}`)
    }
  }

  /** The pane closed: no selection, no help view, no refocus left over. Each write stands alone: one may fail. */
  async closed(p: Ports): Promise<void> {
    this.refocus.clear()
    for (const write of [() => p.state.selected.update(() => null), () => p.state.help.update(() => false)]) {
      try {
        await write()
      } catch (e) {
        p.log(`pane: close failed: ${reason(e)}`)
      }
    }
  }

  /** Resolves when every Button press so far has finished. For tests and for a caller that must not race the work. */
  idle(): Promise<void> {
    return this.work.idle()
  }

  /**
   * Only a press that reads `selected` waits in the chain: `x`, `0`-`3` and a tracker key. Those writes must see each
   * other's selection. An Enter, an "N more", `h` and `r` run at once, so a press that waits for the entry (after a
   * /resume the entry loads the stored copy) never holds them.
   */
  private actionsOf(p: Ports, m: PaneHost): TableActions {
    return {
      toggle: id =>
        this.work.detach(p, 'toggle', async () => {
          await p.state.expanded.update(cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]))
        }),
      more: sectionId =>
        this.work.detach(p, 'more', async () => {
          await p.state.shown.update(sectionId, n => n + m.config.global().ui.sectionRows)
        }),
      press: key => {
        const run = () => this.pressed(p, m, key)
        if (m.keys.get(key)?.scope === 'pane') this.work.detach(p, key, run)
        else this.work.queue(p, key, run)
      },
    }
  }

  private async pressed(p: Ports, m: PaneHost, buttonKey: string): Promise<void> {
    const key = m.keys.get(buttonKey)
    if (key === undefined) return
    const row = findRow(this.sections, await p.state.selected.get())
    const to = route(key, row, owner => m.isItemOwner(owner))
    switch (to.to) {
      case 'refresh':
        resetWidths()
        await m.refreshManual(p)
        return
      case 'help':
        await p.state.help.update(v => !v)
        return
      case 'dismiss': {
        const next = neighbourOf(this.drawn?.rows ?? [], to.rowId)
        await m.dismiss(p, [to.rowId])
        await this.refocus.to(p, m, next)
        return
      }
      case 'priority':
        await m.setPriority(p, to.rowId, to.level)
        await this.refocus.to(p, m, to.rowId)
        return
      case 'owner':
        // A tracker's own work may take long. It must not hold the keys that come after it.
        this.work.detach(p, buttonKey, async () => {
          await m.entry(p)
          await m.runAction(p, to.owner, to.id, to.rowId)
        })
        return
      case 'none':
        return
    }
  }
}

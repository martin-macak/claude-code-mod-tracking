// The preview of the pane (issue #57, L2): the content in module memory, and the work that opens, reloads and leaves a preview.
// The state holds a row id, its owner and a mode, and nothing else. The content (a file, a diff) is read when the person asks and
// sits here, in memory of this load, for the last two views: it is never stored, never in the `/track` text and never in a prompt.
// A hot reload loses it, and the next drawing finds no content: it draws `Loading…` and starts one load, with no state write.
// `PanePreview` owns the whole life of the preview, as `BulkQuestion` and `WorkQueue` own theirs: the cache, the tickets that say which
// press is the newest, the open, the mode keys and the way back on Esc. PaneSession owns one and calls it; nothing here touches the
// engine but the `preview` state port, `ui.open`, `ui.toast` and `ui.invalidate`.
// Design study of issue #57, comment 6414682787 (R10, G11, G18).

import { reason } from '../core/infra/steps'
import type { Ports } from '../core/interfaces/ports'
import type { PreviewContent, PreviewModeId, PreviewState } from '../core/interfaces/preview'
import type { PaneKey } from '../core/interfaces/view'
import type { WorkQueue } from './pane-queue'
import type { Press, Refocus } from './pane-refocus'
import { frameFromState, unlessClosed } from './pane-refocus'
import type { PaneHost } from './pane-text'

/**
 * The views the cache keeps: the one on show and the one before it. A press always reads again; the older view only stays on screen
 * between the `put` of the new content and the write of the state, so a drawing in that gap does not start a read.
 */
const KEPT = 2

const keyOf = (rowId: string, mode: PreviewModeId): string => `${rowId}\u0000${mode}`

/** What the pane has read for the preview: the last `KEPT` contents, and the loads that run. Module memory: nothing here is stored. */
export class PreviewCache {
  private readonly contents = new Map<string, PreviewContent>()
  private readonly running = new Set<string>()

  get(rowId: string, mode: PreviewModeId): PreviewContent | undefined {
    return this.contents.get(keyOf(rowId, mode))
  }

  /** Keeps `content`, as the newest view. The oldest goes when more than `KEPT` are held. */
  put(rowId: string, mode: PreviewModeId, content: PreviewContent): void {
    const key = keyOf(rowId, mode)
    this.contents.delete(key)
    this.contents.set(key, content)
    for (const old of [...this.contents.keys()].slice(0, Math.max(0, this.contents.size - KEPT)))
      this.contents.delete(old)
  }

  /** True once for a view whose load is not running: the caller then runs it and calls `end`. A second ask finds it running. */
  begin(rowId: string, mode: PreviewModeId): boolean {
    const key = keyOf(rowId, mode)
    if (this.running.has(key)) return false
    this.running.add(key)
    return true
  }

  end(rowId: string, mode: PreviewModeId): void {
    this.running.delete(keyOf(rowId, mode))
  }

  /** The pane closed, or the person left the preview: nothing stays in memory. A load that runs still ends and finds the cache empty. */
  clear(): void {
    this.contents.clear()
  }
}

/**
 * Reads the content of `target` and shows it: the content goes into the cache first, then the state names the view, so the first
 * drawing of the view has its content and never says `Loading…`. The state write is guarded by the press: a press that began before
 * a closing writes nothing after it (issue #130). `entering`: the preview was not on show, so the ring goes to the first Button of
 * its key line, as the help view sends it to `h: back` (`Refocus.keep`, issue #140). A reload or a change of mode keeps the ring.
 * The state may be the same as before (`r`), so the pane is asked to draw again.
 */
export async function showPreview(
  p: Ports,
  m: PaneHost,
  cache: PreviewCache,
  refocus: Refocus,
  press: Press,
  target: PreviewState,
  entering: boolean,
): Promise<void> {
  const content = await m.loadPreview(p, target.owner, target.rowId, target.mode)
  if (!press.still()) return
  cache.put(target.rowId, target.mode, content)
  const drawn = entering ? refocus.awaitFrame(p, frame => frame.view === 'preview') : undefined // armed before the write
  const before = await p.state.preview.get()
  await p.state.preview.update(unlessClosed<PreviewState | null>(press, () => target))
  if (!press.still()) return
  if (before?.rowId === target.rowId && before.mode === target.mode) p.ui.invalidate()
  if (drawn !== undefined) {
    const next = { view: 'preview', row: null } as const
    await refocus.keep(p, next, press, drawn, () => frameFromState(p, m, next))
  }
}

/**
 * The drawing found no content for the view that the state names: a hot reload lost module memory, or the cache moved on. One load
 * starts, apart from the drawing, and asks for another drawing when it has the content. A second drawing while it runs starts none.
 * It writes no state: a render must not (E9). `still` is false once the person left the preview or the pane closed: the content is
 * then dropped, so memory holds none of a preview that is not on show. A press (`r`, a mode key) that stored the content of this
 * view while the read ran is newer than the read: the cache holds the view then, and the late read drops its own and keeps it.
 */
export function loadMissing(
  p: Ports,
  m: PaneHost,
  cache: PreviewCache,
  run: (name: string, step: () => Promise<void>) => void,
  shown: PreviewState,
  still: () => boolean,
): void {
  if (!cache.begin(shown.rowId, shown.mode)) return
  run('preview load', async () => {
    try {
      const content = await m.loadPreview(p, shown.owner, shown.rowId, shown.mode)
      if (!still()) return // the person left the preview, or the pane closed: nothing stays in memory
      if (cache.get(shown.rowId, shown.mode) !== undefined) return // a press stored a newer read of this view meanwhile
      cache.put(shown.rowId, shown.mode, content)
      p.ui.invalidate()
    } finally {
      cache.end(shown.rowId, shown.mode)
    }
  })
}

/** What the way back answers the `ui.close` hook: `deny` keeps the pane open (`{}` is no answer: 2.1.310 skips the hook and closes the pane). */
export type CloseAnswer = { readonly deny: string }

/** What PanePreview needs of the pane: the work chain, the ring, the row the pane treats as selected, and a press as the pane makes it. */
export interface PreviewDeps {
  readonly work: WorkQueue
  readonly refocus: Refocus
  readonly selectedRow: (p: Ports) => Promise<string | null>
  readonly pressOf: (keysInPrompt: boolean) => Press
}

/**
 * The life of the preview (issue #57, L2). The state names the view; this owns what the state must not hold: the content in module
 * memory, and the counters that tell a press which work is still wanted.
 *
 * Two counters. `leavings` goes up when the person leaves the preview or the pane closes: the work that began before ends with no
 * write (it is no closing, so `closings` of the pane stays). `tickets` goes up at each press that opens, switches or reloads, and only
 * the newest ticket writes: a slow read of an older press (a hung mount, a git diff) that ends after a newer press must not bring its
 * view back over the newer one.
 */
export class PanePreview {
  private readonly cache = new PreviewCache()
  private leavings = 0
  private tickets = 0

  constructor(private readonly d: PreviewDeps) {}

  /** The pane closed: the content never outlives it, and the work that runs ends with no write. */
  closed(): void {
    this.leavings++
    this.cache.clear()
  }

  /**
   * The content that the drawing of the view `shown` has, or `undefined` while it loads. With none (a hot reload lost memory, or the
   * cache moved on) one read starts, apart from the drawing: it asks for another drawing when it has the content, and it writes no
   * state (E9). A read that ends after the person left drops its content.
   */
  content(p: Ports, m: PaneHost, shown: PreviewState): PreviewContent | undefined {
    const content = this.cache.get(shown.rowId, shown.mode)
    if (content === undefined) {
      const epoch = this.leavings
      loadMissing(
        p,
        m,
        this.cache,
        (name, step) => this.d.work.detach(p, name, step),
        shown,
        () => epoch === this.leavings,
      )
    }
    return content
  }

  /**
   * `v` on a row. The tracker says if the row has the mode: no mode, or one that is off, gives a toast with its reason and nothing
   * opens. Else the read runs outside the chain and the preview opens when it has the content. The help view shows no `v`, so a press
   * from a drawing before `h` opens nothing over it. The ticket is taken before the first wait. A press that comes later then
   * supersedes the read of an earlier press at once, also while this press still waits for the help flag or for its own modes. The
   * checks after each wait end the press when the pane closed or a newer press came (no read is started for it), and the ticket makes
   * a read that runs on lose to a press that comes after it (`showPreview`).
   */
  async open(p: Ports, m: PaneHost, target: PreviewState, buttonKey: string, press: Press): Promise<void> {
    const mine = this.ticket(press)
    if ((await p.state.help.get()) || !mine.still()) return
    if (!(await this.modeOk(p, m, target)) || !mine.still()) return
    this.d.work.detach(p, buttonKey, () => showPreview(p, m, this.cache, this.d.refocus, mine, target, true))
  }

  /**
   * A press while the preview shows: a key that picks a mode reads that mode (`v` the view, `d` the diff), `r` reads the mode on show
   * again. Any other key has no Button in this drawing, so a press that comes from an older drawing does nothing.
   */
  async key(p: Ports, m: PaneHost, key: PaneKey, shown: PreviewState, press: Press): Promise<void> {
    const mode: PreviewModeId | undefined = key.mode ?? (key.id === 'refresh' ? shown.mode : undefined)
    if (mode === undefined) return
    const mine = this.ticket(press)
    const target = { ...shown, mode }
    if (!(await this.modeOk(p, m, target)) || !mine.still()) return
    this.d.work.detach(p, key.id, () => showPreview(p, m, this.cache, this.d.refocus, mine, target, false))
  }

  /**
   * The `ui.close` hook (G11). While a preview shows, a close by the person (Esc, the close mark, `ctrl+x x`: the hook cannot tell them
   * apart) goes back to the list: the preview clears, the pane opens again with the keys, started and not awaited as the engine's own
   * diff mod does it, and the hook answers `deny`. The ring goes back to the selected row as the help view sends it (`Refocus.keep`,
   * issue #140). This is no closing: the selection, the marks and the presses in flight stay, and only the work of the preview ends
   * (`leavings`). Anything else answers nothing, so the pane closes: Esc in the list, a close that the plugin or the engine makes
   * (`unload` is never refused), and a state write that fails, so the person is never held in the preview.
   */
  async closeOrBack(p: Ports, m: PaneHost, origin: 'person' | 'plugin' | 'unload'): Promise<CloseAnswer | undefined> {
    if (origin !== 'person') return undefined
    try {
      if ((await p.state.preview.get()) === null) return undefined
      this.leavings++
      this.cache.clear()
      const press = this.d.pressOf(false)
      const drawn = this.d.refocus.awaitFrame(p, frame => frame.view !== 'preview') // armed before the write
      await p.state.preview.update(() => null)
      void p.ui.open().catch(e => p.log(`pane: reopen failed: ${reason(e)}`)) // the pane stays, with the keys
      this.d.work.detach(p, 'preview back', async () => {
        const next = { view: 'rows', row: await this.d.selectedRow(p) } as const
        await this.d.refocus.keep(p, next, press, drawn, () => frameFromState(p, m, next))
      })
      return { deny: 'back to the list' }
    } catch (e) {
      p.log(`pane: leaving the preview failed: ${reason(e)}`)
      return undefined
    }
  }

  /**
   * The person goes to another place of the pane on purpose: the open Button of a turn strip (issue #69) selects a row and asks for the
   * ring there, and the list is where that row is. So the preview is no longer wanted, as on Esc: the content goes, and so does the
   * work that runs (`leavings`): a read that ends later, a `v` that still reads and a hot-reload read bring nothing back over the
   * turn. It reopens nothing and sends no ring: the press of the strip does that for its own row. It runs also with no preview on show,
   * because a `v` that still reads has not written the state yet. A failed write is the caller's: it ends the press (no turn opens).
   */
  async leave(p: Ports): Promise<void> {
    this.leavings++
    this.cache.clear()
    if ((await p.state.preview.get()) !== null) await p.state.preview.update(() => null)
  }

  /** True when the row has the mode and it is on. Else a toast says why, and the press ends. */
  private async modeOk(p: Ports, m: PaneHost, target: PreviewState): Promise<boolean> {
    const modes = await m.previewModes(p, target.owner, target.rowId)
    const found = modes?.find(x => x.id === target.mode)
    if (found?.enabled === true) return true
    p.ui.toast(found?.reason ?? (modes === undefined ? 'This row has no preview.' : 'This mode is not available.'))
    return false
  }

  /**
   * The press of the preview work, with its ticket. It ends when the person leaves the preview, the pane closes, or a newer press
   * began: a read that was slow brings nothing back, and brings no older view over a newer one.
   */
  private ticket(press: Press): Press {
    const left = this.leavings
    const mine = ++this.tickets
    return { ...press, still: () => press.still() && left === this.leavings && mine === this.tickets }
  }
}

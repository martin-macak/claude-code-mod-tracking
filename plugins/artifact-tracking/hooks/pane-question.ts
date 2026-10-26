// BulkQuestion: the question of a bulk dismiss (issue #138). A bulk `x` asks first: the view line holds the question, and only an
// `x` from a drawing that showed it answers. The question is one small state machine: asked by a press, shown by the first drawing
// that reads it, answered by a press, and withdrawn by a drawing (the targets changed, the pane has no keys) or by the person doing
// something else. PaneSession owns one instance, as it owns a `Refocus` and a `WorkQueue`; nothing here touches the engine.
//
// It is a field of the session and not engine state: a draw may stamp it and withdraw it, and a draw must write no state (E9).

import { sameIds } from '../core/lib/marks'

/** What a press of `x` finds when it meets the question: no question for these rows, one a drawing has not shown, or an answer. */
export type Answer = 'ask' | 'stale' | 'confirm'

export class BulkQuestion {
  /** The rows the question asks about, and the number of the first drawing that showed it (absent: no drawing has yet). */
  private asked: { readonly ids: readonly string[]; readonly shown: number | undefined } | undefined

  /** The rows the question asks about. Absent: no question stands. */
  get ids(): readonly string[] | undefined {
    return this.asked?.ids
  }

  /** Asks about `ids`. The first drawing that reads the question shows it (`read`). */
  ask(ids: readonly string[]): void {
    this.asked = { ids, shown: undefined }
  }

  /**
   * A drawing reads the question. It stands while the same rows are its targets and the pane has the keys: a drawing without
   * them (or the help view) and a change of the targets withdraw it. The first drawing that reads it notes its number: only a
   * press from that drawing or a later one answers it. True when the question stands after this drawing.
   */
  read(drawing: number, targets: readonly string[], hasKeys: boolean): boolean {
    if (this.asked !== undefined && (!hasKeys || !sameIds(this.asked.ids, targets))) this.asked = undefined
    if (this.asked !== undefined && this.asked.shown === undefined) this.asked = { ids: this.asked.ids, shown: drawing }
    return this.asked !== undefined
  }

  /**
   * What an `x` press from `drawing` finds. `ask`: no question stands for these targets, so the press asks. `stale`: the question
   * stands but no drawing showed it to that press, so a double tap whose second press comes from an older drawing asks and never
   * dismisses. `confirm`: the press comes from a drawing that showed the question.
   */
  answer(drawing: number, targets: readonly string[]): Answer {
    const asked = this.asked
    if (asked === undefined || !sameIds(asked.ids, targets)) return 'ask'
    return asked.shown === undefined || drawing < asked.shown ? 'stale' : 'confirm'
  }

  /** The question ends. True when one stood, so the pane must draw without it. */
  clear(): boolean {
    const stood = this.asked !== undefined
    this.asked = undefined
    return stood
  }
}

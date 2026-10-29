// The preview contract (issue #57, L2): what a tracker gives the pane so that a selected row opens in a view of its own. A tracker
// that has a `preview` says which modes a row has (`modes`, pure, at render) and reads the content of one mode when the person
// asks (`load`, at a press). Core owns the pane that draws it, the keys (`v`, `d`, `r`) and the size budget. The content is never
// stored: the state holds a row id and a mode, and the content sits in module memory of the pane (`hooks/pane-preview.ts`).
// Types only. Design study of issue #57, comment 6414682787 (R9, R10).

import type { Json, JsonObject } from './items'
import type { TrackerContext } from './tracker'
import type { ViewContext } from './view'

/**
 * The id of a mode of a preview: an open word, as the stored `view` atom is open. A provider lists the modes of a row (`view`,
 * `diff`), and core adds modes of its own (issue #275 adds `detail`). Core reserves the keys of the modes it knows: `v` picks `view`
 * and `d` picks `diff`, by `PaneKey.mode` (`core/infra/keys.ts`, `CORE_KEYS`: the one table). A mode that no core key picks has no
 * Button on the key line; a provider may still load it, for example when the press of another key asks for it.
 */
export type PreviewModeId = string

/** One mode of a row. `enabled: false` draws the Button dim; a press says `reason` in a toast and loads nothing. */
export interface PreviewMode {
  readonly id: PreviewModeId
  readonly enabled: boolean
  /** Why the mode is off: the words of the toast. */
  readonly reason?: string
}

/**
 * One block of the content, in the order they are drawn. `code` is source with a line gutter (the language comes from `path`
 * or `language`). `diff` is a unified diff. `markdown` is Markdown. `notice` is one line of words that says what the person
 * cannot see (a truncated file, a binary one, a secret): it is drawn before the content, so a cut never takes it.
 */
export type PreviewBlock =
  | {
      readonly kind: 'code'
      readonly source: string
      readonly path?: string
      readonly language?: string
      readonly startLine?: number
    }
  | { readonly kind: 'diff'; readonly source: string; readonly path?: string }
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'notice'; readonly text: string; readonly tone?: 'info' | 'warning' }

/** What one mode shows: a title line, a dim second part of the line, and the blocks. Never stored. */
export interface PreviewContent {
  readonly title: string
  readonly subtitle?: string
  readonly blocks: readonly PreviewBlock[]
}

/**
 * The most that core draws: the caps of the drawing (the engine draws 100,000 characters in all). A provider keeps its own
 * smaller caps inside these. Core still guards the budget, whatever a provider returns.
 */
export interface PreviewLimits {
  readonly maxLines: number
  readonly maxChars: number
}

/** What a tracker gives to get a preview. Methods, so a `PreviewSpec<MyConfig, MyData>` fits a `Tracker` list. */
export interface PreviewSpec<C extends JsonObject = JsonObject, D extends Json = Json> {
  /** Pure, at render: the modes of a row, or `undefined` for a row that has no preview. */
  modes(ctx: ViewContext<C, D>, rowId: string): readonly PreviewMode[] | undefined
  /** At a press: reads the content of one mode. A rejection draws as a notice. The content is never stored. */
  load(ctx: TrackerContext<C, D>, rowId: string, mode: PreviewModeId, limits: PreviewLimits): Promise<PreviewContent>
}

/**
 * The preview the pane shows, as the session atom keeps it: which row of which tracker, in which mode. A row id and a word, no
 * content. `/clear` resets it and the pane clears it at close.
 */
export interface PreviewState {
  readonly rowId: string
  readonly owner: string
  readonly mode: PreviewModeId
}

// The numbers and the stand-in contents of the preview (issue #57, L2). Pure: no state, no I/O.

import type { PreviewContent, PreviewLimits, PreviewModeId } from '../interfaces/preview'

/**
 * The core mode of the preview body (issue #275, L2): the detail view of a row. Every row has it, so no provider lists it and none
 * loads it. Core builds its content from the row itself at each drawing (`core/lib/detail.ts`), so it is never in the cache and a
 * hot reload cannot lose it. Enter opens it. No key picks it: the `↩ back` Button and Esc leave it.
 */
export const DETAIL_MODE: PreviewModeId = 'detail'

/**
 * The most that core draws of one preview. The engine draws 100,000 characters in all, and the guard of the pane keeps 80,000 of
 * them for a whole drawing (`ux/tree-data-table/budget.ts`), so 70,000 leave room for the header, the key line and a notice. A
 * provider keeps its own caps inside these (the file tracker: 2,000 lines and 60,000 characters). The config of a provider may
 * not go above them.
 */
export const PREVIEW_LIMITS: PreviewLimits = { maxLines: 10_000, maxChars: 70_000 }

/** The title of a preview that has no content of its own: a load that failed, a row that has no preview. */
const FALLBACK_TITLE = 'Preview'

/** The content that stands in for a load that rejected: one warning line with the reason. */
export const failedPreview = (reason: string): PreviewContent => ({
  title: FALLBACK_TITLE,
  blocks: [{ kind: 'notice', text: `The preview could not be read: ${reason}`, tone: 'warning' }],
})

/** The content for a row whose tracker has no preview. The footer draws no `v` for such a row, so this is a stale press. */
export const noPreview = (): PreviewContent => ({
  title: FALLBACK_TITLE,
  blocks: [{ kind: 'notice', text: 'This row has no preview.', tone: 'info' }],
})

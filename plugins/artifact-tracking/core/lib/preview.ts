// The numbers and the stand-in contents of the preview (issue #57, L2). Pure: no state, no I/O.

import type { PreviewContent, PreviewLimits } from '../interfaces/preview'

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

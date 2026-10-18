import { StaticItem } from '../../core/lib/tracked-item'
import type { FileRecord } from '../../hooks/contracts'

/** A tracked Markdown file (issue #28). It is track-only: never due, never refreshed. */
export class FileItem extends StaticItem {
  readonly category = 'file' as const
  created: boolean
  edits: number
  views: number
  mentions: number
  bySubagent?: true

  constructor(rec: FileRecord) {
    super(rec)
    this.created = rec.created
    this.edits = rec.edits
    this.views = rec.views
    this.mentions = rec.mentions
    if (rec.bySubagent) this.bySubagent = true
  }

  toRecord(): FileRecord {
    return {
      ...this.baseRecord(),
      category: 'file',
      created: this.created,
      edits: this.edits,
      views: this.views,
      mentions: this.mentions,
      ...(this.bySubagent ? { bySubagent: true as const } : {}),
    }
  }
}

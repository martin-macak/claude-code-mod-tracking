import type { FileRecord } from '../contracts'
import { TrackedItem } from './tracked-item'

/** A tracked Markdown file (issue #28). It is track-only: never due, never refreshed. */
export class FileItem extends TrackedItem {
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

  override isDue(_now: number): boolean {
    return false
  }

  canRefresh(): boolean {
    return false
  }

  async refresh(): Promise<void> {
    // No-op: the counters change only through tool calls and text.
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

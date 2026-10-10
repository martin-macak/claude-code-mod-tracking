// A web link. It has no status, so it never refreshes.

import type { WebRecord } from '../contracts'
import { TrackedItem } from './tracked-item'

export class WebLink extends TrackedItem {
  readonly category = 'web' as const

  constructor(rec: WebRecord) {
    super(rec)
  }

  canRefresh(_now: number): boolean {
    return false
  }

  async refresh(): Promise<void> {}

  override isDue(_now: number): boolean {
    return false
  }

  toRecord(): WebRecord {
    return { ...this.baseRecord(), category: 'web' }
  }
}

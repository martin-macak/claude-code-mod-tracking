// A web link. It has no status, so it never refreshes.

import { StaticItem } from '../../core/lib/tracked-item'
import type { WebRecord } from '../../hooks/contracts'

export class WebLink extends StaticItem {
  readonly category = 'web' as const

  constructor(rec: WebRecord) {
    super(rec)
  }

  toRecord(): WebRecord {
    return { ...this.baseRecord(), category: 'web' }
  }
}

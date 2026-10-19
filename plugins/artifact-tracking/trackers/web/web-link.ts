// A web link. It has no status, so it never refreshes.

import type { WebRecord } from '../../hooks/contracts'
import { StaticItem } from '../../hooks/model/tracked-item'

export class WebLink extends StaticItem {
  readonly category = 'web' as const

  constructor(rec: WebRecord) {
    super(rec)
  }

  toRecord(): WebRecord {
    return { ...this.baseRecord(), category: 'web' }
  }
}

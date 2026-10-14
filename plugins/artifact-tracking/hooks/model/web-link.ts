// A web link. It has no status, so it never refreshes.

import type { WebRecord } from '../contracts'
import { StaticItem } from './tracked-item'

export class WebLink extends StaticItem {
  readonly category = 'web' as const

  constructor(rec: WebRecord) {
    super(rec)
  }

  toRecord(): WebRecord {
    return { ...this.baseRecord(), category: 'web' }
  }
}

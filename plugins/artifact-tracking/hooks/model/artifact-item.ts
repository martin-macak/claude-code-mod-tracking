// A Claude artifact (issue #29). No tool reads its status, so it never refreshes. The origin comes from the sources.

import type { ArtifactRecord } from '../contracts'
import { StaticItem } from './tracked-item'

export class ArtifactItem extends StaticItem {
  readonly category = 'artifact' as const
  deleted?: true

  constructor(rec: ArtifactRecord) {
    super(rec)
    if (rec.deleted) this.deleted = true
  }

  toRecord(): ArtifactRecord {
    return { ...this.baseRecord(), category: 'artifact', ...(this.deleted ? { deleted: true as const } : {}) }
  }
}

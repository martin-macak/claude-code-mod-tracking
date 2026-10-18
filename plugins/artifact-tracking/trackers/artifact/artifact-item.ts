// A Claude artifact (issue #29). No tool reads its status, so it never refreshes. The origin comes from the sources.

import { StaticItem } from '../../core/lib/tracked-item'
import type { ArtifactRecord } from '../../hooks/contracts'

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

// The row of a Claude artifact: its name, its id and its origin. A deleted page is dimmed and has no link. Pure. The
// cells keep the text the pane drew before L6; tests/item-sections.test.ts pins them.
// Plan: L5 Task 13, L6 A1.

import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { itemRow } from '../../core/lib/rows'
import { NO_STATUS } from '../../core/lib/status'
import { artifactIdOf } from './artifact-url'
import { artifactOrigin } from './records'
import type { ArtifactRecord } from './types'

export function artifactRow(item: ArtifactRecord, env: Pick<ViewContext, 'levelOf'>): TreeRow {
  const id = artifactIdOf(item.url)
  return itemRow({
    id: item.key,
    owner: 'artifact',
    level: env.levelOf(item.key),
    dismiss: true,
    reasons: item.reasons,
    firstSeen: item.firstSeen,
    ...(item.deleted ? { dim: true } : {}),
    text: {
      key: item.label,
      ...(item.deleted ? {} : { href: item.url }),
      title: item.label === id ? '' : id,
      type: artifactOrigin(item),
      // A deleted page is gone. Any other has no state to speak of.
      status: item.deleted ? { label: 'deleted', token: 'gone' } : NO_STATUS,
    },
  })
}

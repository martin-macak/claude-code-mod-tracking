// Item keys and the auto-only test (spec 6.2, A9). No state, no I/O. A binding over the item kinds (plan L5, Task 4):
// each kind builds its own key, and these functions dispatch to them by the category of a ref. Scan, model and ui import
// them from here, so none of them has to pull in `registry.ts` or `discovered.ts` for a key.

import type { Claim, JsonObject } from '../../core/interfaces/items'
import { isAutoOnly } from '../../core/lib/records'
import { artifactKeyOf } from '../../trackers/artifact/kind'
import { artifactOrigin } from '../../trackers/artifact/records'
import { fileKey } from '../../trackers/file/kind'
import { githubKeyOf, prKey } from '../../trackers/github/urls'
import { jiraKeyOf } from '../../trackers/jira/kind'
import { childId } from '../../trackers/jira/nodes'
import { webKeyOf } from '../../trackers/web/kind'
import type { Ref } from '../contracts'

/** The key of a ref, or of a claim, which carries it. */
export function keyOf(ref: Ref | Claim): string {
  if ('key' in ref) return ref.key
  switch (ref.category) {
    case 'github':
      return githubKeyOf(ref)
    case 'jira':
      return jiraKeyOf(ref)
    case 'artifact':
      return artifactKeyOf(ref)
    case 'web':
      return webKeyOf(ref)
  }
}

/** The claims of some refs: each ref seen from `source` at `at`, with the ref fields under the category. */
export function claimsOf(refs: readonly Ref[], source: string, at: number): Claim[] {
  return refs.map(ref => {
    const { category, ...fields } = ref
    return { category, key: keyOf(ref), source, at, fields: fields as unknown as JsonObject }
  })
}

// The keys that are not a function of a ref, and the two tests, live with their kinds. The old callers read them here.
export { artifactOrigin, childId, fileKey, isAutoOnly, prKey }

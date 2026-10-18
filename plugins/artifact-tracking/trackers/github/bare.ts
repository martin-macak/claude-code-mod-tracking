// A bare `#N` has no repo until the session repo is known. When it is, the record moves to its real key and folds into
// a twin that already has it. Pure: no input list or record is mutated. Moved from `hooks/model/registry.ts`.
// Plan: L5 Task 4.

import type { StoredItem } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import { cloneRecord, foldRecords } from '../../core/lib/records'
import { githubKind } from './kind'
import type { GitHubRecord } from './types'
import { githubKey, githubUrl } from './urls'

const onlyGithub = (category: string) => (category === 'github' ? githubKind : undefined)

export function resolveBareRefs(list: readonly StoredItem[], repo: RepoRef): StoredItem[] {
  const host = repo.host.toLowerCase()
  const owner = repo.owner.toLowerCase()
  const name = repo.repo.toLowerCase()
  const out: (StoredItem | null)[] = list.map(cloneRecord)
  const index = new Map<string, number>()
  out.forEach((r, i) => {
    if (r && !r.key.startsWith('gh:?#')) index.set(r.key, i)
  })
  out.forEach((rec, i) => {
    const bare = rec && githubKind.decode(rec)
    if (!bare?.key.startsWith('gh:?#')) return
    const key = githubKey(host, owner, name, bare.number)
    const moved: GitHubRecord = {
      ...bare,
      key,
      host,
      owner,
      repo: name,
      label: `${owner}/${name}#${bare.number}`,
      url: githubUrl(host, owner, name, bare.type, bare.number),
    }
    const at = index.get(key)
    if (at === undefined) {
      out[i] = moved
      index.set(key, i)
    } else {
      out[at] = foldRecords(out[at]!, moved, onlyGithub)
      out[i] = null
    }
  })
  return out.filter((r): r is StoredItem => r !== null)
}

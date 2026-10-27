// The files a Bash command changed (issue #57, R4a). The engine reports them in the result of the call, as `bashEditDiff`:
// `files` holds the diffs of up to 5 files with `created` or `deleted` set, and `changedFiles` names up to 200 absolute paths,
// shown or not. The field is `@internal` and in public beta: it is read with guards, and an absent or odd field adds nothing.
// It exists for a command that runs inside a git work tree only (a write outside it has no field), and for a command that
// Claude Code records (auto mode, `bypassPermissions`, or `bashEditDiffEnabled`). A Bash read (`cat`, `head`) is not seen.
// Pure: no `$`, no I/O.

import { isRecord } from '../../core/lib/json'
import type { FileTouch } from './files'

/**
 * The files one finished Bash call changed, as touches: a file with `created` is `created`, a file with `deleted` is `deleted`,
 * any other file of `files` was modified (`edited`), and a path of `changedFiles` that `files` does not show is `edited` too
 * (no flag is known for it). A path comes once. `ran` is what `await next(e)` gave, or a transcript tool use.
 *
 * A call that failed still counts when the engine reports files: the field says what changed on disk. A denied or staged call
 * has none. The flags `unavailable`, `skipped` and `shared` do not stop the read: they say the list may be incomplete or may
 * hold a change of a concurrent command, and the files that are named did change.
 */
export function bashTouches(ran: unknown): FileTouch[] {
  if (!isRecord(ran) || ran.deny !== undefined) return []
  const r = ran.result
  if (!isRecord(r) || r.staged === true || !isRecord(r.bashEditDiff)) return []
  const diff = r.bashEditDiff
  const out = new Map<string, FileTouch>()
  const add = (spelled: unknown, kind: FileTouch['kind']): void => {
    if (typeof spelled === 'string' && spelled !== '' && !out.has(spelled)) out.set(spelled, { spelled, kind })
  }
  for (const f of Array.isArray(diff.files) ? diff.files : [])
    if (isRecord(f)) add(f.filePath, f.deleted === true ? 'deleted' : f.created === true ? 'created' : 'edited')
  for (const p of Array.isArray(diff.changedFiles) ? diff.changedFiles : []) add(p, 'edited')
  return [...out.values()]
}

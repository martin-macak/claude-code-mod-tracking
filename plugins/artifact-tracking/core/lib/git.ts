// Git remotes. Pure: no state, no I/O. Moved from `hooks/scan/refs.ts` in plan L5, Task 5 (K23): two trackers read
// remotes, and a tracker folder imports no other, so the parser lives here and each folder passes its own alias table.

import type { RepoRef } from '../interfaces/ports'

const MAX_REMOTE = 2048

/**
 * `owner/repo` of a git remote: scp form, ssh://, https:// (credentials dropped), git://. `aliases` maps a host the
 * remote spells to the host it stands for (lower case on both sides), e.g. an ssh-over-443 gateway to the main host.
 */
export function parseRemote(remote: string, aliases: Readonly<Record<string, string>> = {}): RepoRef | null {
  if (!remote || remote.length > MAX_REMOTE) return null
  const m =
    /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote) ??
    /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote)
  if (!m) return null
  const scp = !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)
  if (scp && m[1]!.length < 2) return null // `C:/dir/x` is a path, not a host
  const host = m[1]!.toLowerCase()
  return { host: aliases[host] ?? host, owner: m[2]!, repo: m[3]! }
}

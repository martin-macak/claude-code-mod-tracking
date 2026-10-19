// How the github tracker reads a git remote: its own alias table over the generic parser in `core/lib/git.ts` (K23).

import type { RepoRef } from '../../core/interfaces/ports'
import { parseRemote as parseGitRemote } from '../../core/lib/git'

/** The host a remote spells, to the host it stands for: GitHub serves ssh over port 443 on `ssh.github.com`. */
export const HOST_ALIASES: Readonly<Record<string, string>> = { 'ssh.github.com': 'github.com' }

/** `owner/repo` of a git remote, with the host aliases of GitHub. The wiring reads the session remote with it (`trackers/index.ts`). */
export const parseRemote = (remote: string): RepoRef | null => parseGitRemote(remote, HOST_ALIASES)

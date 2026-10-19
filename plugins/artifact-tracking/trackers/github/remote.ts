// How the github tracker reads a git remote: its own alias table over the generic parser in `core/lib/git.ts` (K23).

/** The host a remote spells, to the host it stands for: GitHub serves ssh over port 443 on `ssh.github.com`. */
export const HOST_ALIASES: Readonly<Record<string, string>> = { 'ssh.github.com': 'github.com' }

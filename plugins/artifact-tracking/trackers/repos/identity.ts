import { basename, normPath } from '../../core/lib/porcelain'
import type { RepoRef } from '../../hooks/contracts'
import { lower, within } from './paths'

/**
 * The host a remote spells, to the host it stands for. The repos tracker keeps its own table (K23): a tracker folder
 * imports no other, so it does not read the table of another tracker for the same host.
 */
export const REMOTE_ALIASES: Readonly<Record<string, string>> = { 'ssh.github.com': 'github.com' }

export function remoteKey(ref: RepoRef): string {
  return `remote:${lower(ref.host)}/${lower(ref.owner)}/${lower(ref.repo)}`
}

/**
 * Identity of a repo without a usable remote. The git common dir is shared by a repo and all its worktrees, so they get
 * one key. The name is the folder of a normal repo (`<dir>/.git`), else the common dir without `.git` (a bare repo).
 */
export function localIdentity(common: string): { key: string; name: string } {
  const c = normPath(common)
  const name = c.endsWith('/.git') ? basename(c.slice(0, -'/.git'.length) || '/') : basename(c).replace(/\.git$/i, '')
  return { key: `local:${c}`, name }
}

/**
 * Identity for a remote that `parseRemote` rejects (sub-groups, Azure DevOps, plain paths). No scheme, userinfo, port,
 * trailing slash or `.git`, so a key never holds credentials.
 */
export function normalizeRemoteUrl(raw: string): { key: string; name: string } {
  const r = raw.trim()
  const file = /^file:\/\/[^/]*(\/.*)$/i.exec(r)
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(r)
  const scp = hasScheme ? null : /^(?:[^@/]+@)?([^:/@]{2,}):(.*)$/.exec(r)
  const strip = (x: string) => x.replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!hasScheme && !scp) return fileIdentity(r)
  if (file) return fileIdentity(file[1]!)
  let host: string
  let path: string
  if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    const rest = r.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    const slash = rest.indexOf('/')
    const auth = slash < 0 ? rest : rest.slice(0, slash)
    host = auth.slice(auth.lastIndexOf('@') + 1).replace(/:\d*$/, '')
    path = slash < 0 ? '' : rest.slice(slash + 1)
  }
  const clean = lower(strip(path.replace(/^\/+/, '')))
  const h = lower(host)
  return { key: `remote:${h}${clean ? `/${clean}` : ''}`, name: clean || h }
}

function fileIdentity(path: string): { key: string; name: string } {
  const p = normPath(path).replace(/\.git$/i, '')
  return { key: `remote:file:${p}`, name: basename(p) }
}

export type Env = { home: string; tmpdir?: string; configDir?: string }

const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/var/folders', '/private/var/folders']
const CLAUDE_HOME_DIR = /^\.claude([-_.].*)?$/
const HOME_GUESS = /^\/(?:users|home)\/[^/]+|^\/root(?=\/|$)/

function homeOf(p: string, env: Env | undefined): string | undefined {
  if (p === '~' || p.startsWith('~/')) return '~'
  if (env) return lower(normPath(env.home))
  return HOME_GUESS.exec(p)?.[0]
}

/** Noise: tmp, Claude's own config and data, node_modules, scratchpads. Compares lower-case, by whole path segment. */
export function isNoisePath(path: string, env?: Env): boolean {
  const p = lower(normPath(path))
  if (TMP_ROOTS.some(t => within(p, t))) return true
  for (const extra of [env?.tmpdir, env?.configDir]) if (extra && within(p, lower(normPath(extra)))) return true
  const home = homeOf(p, env)
  if (home !== undefined && within(p, home) && p !== home) {
    const rest = p.slice(home.length + 1)
    if (CLAUDE_HOME_DIR.test(rest.split('/')[0]!)) return true
    if (within(rest, '.local/share/claude')) return true
  }
  const segs = p.split('/')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    if (seg === 'node_modules' || seg === 'scratchpad') return true
    if (seg.startsWith('.claude') && (segs[i + 1] === 'plugins' || segs[i + 1] === 'cache')) return true
  }
  return false
}

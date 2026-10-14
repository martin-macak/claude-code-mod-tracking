import { basename, normPath } from '../auto/porcelain'
import type { RepoRecord, RepoRef, Runner, RunResult } from '../contracts'
import { LIMITS } from '../contracts'
import { splitShell, stripWrappers } from '../process/shell'
import { parseRemote } from '../scan/refs'
import { CircuitBreaker } from '../tools/circuit-breaker'

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'Grep', 'Glob'])

const SLUG = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
const HOST_SLUG = /^([A-Za-z0-9.-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/

const STRIPPED = /\/$/

const lower = (s: string): string => s.toLowerCase()

function remoteKey(ref: RepoRef): string {
  return `remote:${lower(ref.host)}/${lower(ref.owner)}/${lower(ref.repo)}`
}

/**
 * Identity of a repo without a usable remote. The git common dir is shared by a repo and all its worktrees, so they get
 * one key. The name is the folder of a normal repo (`<dir>/.git`), else the common dir without `.git` (a bare repo).
 */
function localIdentity(common: string): { key: string; name: string } {
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

function cleanPath(path: string): string {
  return path.replace(STRIPPED, '') || '/'
}

function isAbs(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~/')
}

function joinPath(base: string, rel: string): string {
  if (rel.startsWith('/')) return normPath(rel)
  const out: string[] = []
  for (const part of `${base}/${rel}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(part)
  }
  return '/' + out.join('/')
}

function maybeDir(path: string): string {
  const p = cleanPath(path)
  if (p === '/' || p.endsWith('/')) return normPath(p)
  const tail = p.slice(p.lastIndexOf('/') + 1)
  if (tail === '' || (!tail.includes('.') && !tail.startsWith('.'))) return normPath(p)
  const cut = p.slice(0, p.lastIndexOf('/'))
  return normPath(cut || '/')
}

function parseGhRepoArg(text: string): RepoRef | null {
  const t = text.trim()
  if (!t) return null
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/#?]+)(?:[/?#].*)?$/.exec(t)
  if (url) return { host: lower(url[1]!), owner: url[2]!, repo: url[3]!.replace(/\.git$/, '') }
  const hostSlug = HOST_SLUG.exec(t)
  if (hostSlug) return { host: lower(hostSlug[1]!), owner: hostSlug[2]!, repo: hostSlug[3]! }
  const slug = SLUG.exec(t)
  if (slug) return { host: 'github.com', owner: slug[1]!, repo: slug[2]! }
  return null
}

function parseGitCPath(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (w === '-C') return words[i + 1]
    if (w.startsWith('-C') && w.length > 2) return w.slice(2)
  }
  return undefined
}

function parseGhRepo(words: readonly string[]): RepoRef | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (w === '-R' || w === '--repo') return parseGhRepoArg(words[i + 1] ?? '')
    if (w.startsWith('--repo=')) return parseGhRepoArg(w.slice('--repo='.length))
    if (w.startsWith('-R') && w.length > 2) return parseGhRepoArg(w.slice(2))
  }
  return null
}

export function extractRepoPathsFromTool(tool: string, input: unknown): string[] {
  if (!PATH_TOOLS.has(tool)) return []
  if (!input || typeof input !== 'object') return []
  const rec = input as Record<string, unknown>
  const out: string[] = []
  const push = (x: unknown) => {
    if (typeof x === 'string' && x !== '') out.push(x)
    else if (Array.isArray(x)) for (const v of x) if (typeof v === 'string' && v !== '') out.push(v)
  }
  push(rec.file_path)
  push(rec.path)
  push(rec.paths)
  return out
}

export function parseRepoHintsFromBash(command: string, cwd?: string): { paths: string[]; repos: RepoRef[] } {
  const paths: string[] = []
  const repos: RepoRef[] = []
  let dir = cwd
  for (const seg of splitShell(command)) {
    const words = stripWrappers(seg.words).words
    if (words.length === 0) continue
    const head = words[0]!
    if (head === 'cd' || head === 'pushd') {
      const target = words.slice(1).find(w => !w.startsWith('-'))
      if (target !== undefined) {
        if (target === '~') dir = undefined
        else if (target.startsWith('/') || target.startsWith('~/')) dir = target
        else if (dir) dir = joinPath(dir, target)
        if (dir && isAbs(dir)) paths.push(normPath(cleanPath(dir)))
      }
      continue
    }
    if (head === 'git') {
      const p = parseGitCPath(words)
      if (p && isAbs(p)) paths.push(normPath(cleanPath(p)))
      else if (p && dir) paths.push(joinPath(dir, p))
      continue
    }
    if (head === 'gh') {
      const ref = parseGhRepo(words)
      if (ref) repos.push(ref)
    }
  }
  return { paths, repos }
}

export type Env = { home: string; tmpdir?: string; configDir?: string }

const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/var/folders', '/private/var/folders']
const CLAUDE_HOME_DIR = /^\.claude([-_.].*)?$/
const HOME_GUESS = /^\/(?:users|home)\/[^/]+|^\/root(?=\/|$)/

/** True when `base` is `p` or a parent of `p`. Whole segments only. */
function within(p: string, base: string): boolean {
  return p === base || p.startsWith(`${base}/`)
}

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

type ResolvedRepo = {
  key: string
  name: string
  root?: string
  branch?: string
  /** Absolute git common dir. Equal for a repo and its worktrees. Identity only: never stored in a row. */
  common: string
}

type TrackerDeps = {
  run: Runner
  now: () => number
  rootPath?: string
  rootRepo?: RepoRef | null
}

export type RepoVisit = Omit<ResolvedRepo, 'common'> & { touchedBy: string }

/** Every git and sh call runs in `/`: a cwd that is a file or a missing directory would make the spawn itself fail. */
async function call(run: Runner, argv: readonly string[]): Promise<RunResult> {
  return run(argv, { cwd: '/', timeoutMs: LIMITS.gitTimeoutMs })
}

const MAX_WALK = 4
const MISSING = /cannot change to/i

/** A repo, null (not a repo) or 'missing' (the path does not exist or is a file). */
type Answer = ResolvedRepo | null | 'missing'

const isAbsolute = (p: string): boolean => p.startsWith('/')

function visitOf(r: ResolvedRepo, touchedBy: string): RepoVisit {
  const out: RepoVisit = { key: r.key, name: r.name, touchedBy }
  if (r.root !== undefined) out.root = r.root
  if (r.branch !== undefined) out.branch = r.branch
  return out
}

export class RepoTracker {
  private readonly breaker = new CircuitBreaker()
  /** Repos stay for the session. null and 'missing' expire after one tick. */
  private readonly cache = new Map<string, { value: Answer; at: number }>()
  private readonly pending = new Map<string, Promise<Answer | 'retry'>>()
  private readonly byRoot = new Map<string, ResolvedRepo>()
  private env: Promise<Env | undefined> | undefined

  constructor(private readonly d: TrackerDeps) {}

  private ownRemoteKey(): string | undefined {
    return this.d.rootRepo ? remoteKey(this.d.rootRepo) : undefined
  }

  /**
   * The session's own repo, found by git from the root folder: a record, null (the root is not in a repo) or 'retry'
   * (the root is not known yet, or git gave no answer). A definite answer is cached by `lookup`.
   */
  private async ownIdentity(): Promise<ResolvedRepo | null | 'retry'> {
    const rootPath = this.d.rootPath
    if (!rootPath) return 'retry'
    const r = await this.lookup(normPath(rootPath), await this.getEnv())
    if (r === 'retry') return 'retry'
    return r === 'missing' ? null : r
  }

  /** A ref is a foreign repo unless it is the session's own remote. Unknown own identity and no `rootRepo`: no answer. */
  async fromRepoRef(ref: RepoRef, touchedBy: string): Promise<RepoVisit | null> {
    const key = remoteKey(ref)
    const own = await this.ownIdentity()
    if (own !== null && own !== 'retry' && key === own.key) return null
    const rootKey = this.ownRemoteKey()
    if (rootKey !== undefined && key === rootKey) return null
    if (own === 'retry' && rootKey === undefined) return null
    return { key, name: `${ref.owner}/${ref.repo}`, touchedBy }
  }

  /** HOME, TMPDIR and CLAUDE_CONFIG_DIR of the engine. `run` gets an argv, so no shell expands a tilde. Only a success is cached. */
  private getEnv(): Promise<Env | undefined> {
    if (this.env === undefined) {
      const probe = this.probeEnv()
      this.env = probe
      void probe.then(e => {
        if (e === undefined && this.env === probe) this.env = undefined
      })
    }
    return this.env
  }

  private async probeEnv(): Promise<Env | undefined> {
    try {
      const r = await call(this.d.run, ['sh', '-c', 'printf "%s\\n%s\\n%s\\n" "$HOME" "$TMPDIR" "$CLAUDE_CONFIG_DIR"'])
      if (r.exitCode !== 0) return undefined
      const [home = '', tmp = '', cfg = ''] = r.stdout.split('\n').map(x => x.trim())
      if (!home.startsWith('/')) return undefined
      const abs = (x: string): string | undefined => {
        const c = x.startsWith('/') ? cleanPath(x) : ''
        return c && c !== '/' ? c : undefined
      }
      const env: Env = { home: cleanPath(home) }
      const tmpdir = abs(tmp)
      const configDir = abs(cfg)
      if (tmpdir) env.tmpdir = tmpdir
      if (configDir) env.configDir = configDir
      return env
    } catch {
      return undefined
    }
  }

  async resolvePath(path: string, touchedBy: string): Promise<RepoVisit | null> {
    if (!isAbs(path) || isNoisePath(path)) return null
    const env = await this.getEnv()
    let abs = path
    if (path.startsWith('~/')) {
      if (!env) return null
      abs = normPath(`${env.home}/${path.slice(2)}`)
    }
    if (isNoisePath(abs, env)) return null
    // The session's own repo comes first. Without it, a path of the own repo would be cached as foreign.
    const own = await this.ownIdentity()
    if (own === 'retry') return null
    const here = normPath(abs)
    if (within(here, normPath(this.d.rootPath!)) || (own?.root !== undefined && within(here, own.root))) return null
    // A file (README, Makefile) or a path not created yet is not a directory. Walk up to the nearest one that is.
    let dir = maybeDir(abs)
    for (let up = 0; up <= MAX_WALK; up++) {
      const r = await this.lookup(dir, env)
      if (r === 'retry') return null
      if (r !== 'missing') return r && !this.isOwn(r, own) ? visitOf(r, touchedBy) : null
      if (dir === '/') return null
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
    }
    return null
  }

  /**
   * The own repo: same git common dir (a worktree), same key (a clone with the same origin) or the `rootRepo` remote.
   * A repo nested inside the root folder never gets here: it is under the root path.
   */
  private isOwn(r: ResolvedRepo, own: ResolvedRepo | null): boolean {
    if (own && (r.common === own.common || r.key === own.key)) return true
    const rootKey = this.ownRemoteKey()
    return rootKey !== undefined && r.key === rootKey
  }

  /**
   * Cached answer for a directory. Parallel calls share one lookup. A "not now" answer (breaker open, git fault) is
   * never cached ('retry').
   */
  private async lookup(dir: string, env: Env | undefined): Promise<Answer | 'retry'> {
    const hit = this.cache.get(dir)
    if (hit) {
      if (hit.value !== null && hit.value !== 'missing') return hit.value
      if (this.d.now() - hit.at < LIMITS.tickMs) return hit.value
      this.cache.delete(dir)
    }
    let p = this.pending.get(dir)
    if (!p) {
      p = (async () => {
        try {
          const r = await this.resolveDir(dir, env)
          if (r !== 'retry') this.cache.set(dir, { value: r, at: this.d.now() })
          return r
        } finally {
          this.pending.delete(dir)
        }
      })()
      this.pending.set(dir, p)
    }
    return p
  }

  /**
   * One `rev-parse` gives the toplevel and the git common dir. git older than 2.31 does not know `--path-format`: it
   * echoes the option, so a line is not absolute. Then ask again without it and join a relative common dir onto `dir`.
   * Throws when git cannot run.
   */
  private async probeDir(dir: string): Promise<{ top: string; common: string } | null | 'missing'> {
    const base = ['git', '-C', dir, 'rev-parse']
    const lines = (r: RunResult) =>
      r.stdout
        .split('\n')
        .map(x => x.trim())
        .filter(x => x !== '')
    let r = await call(this.d.run, [...base, '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
    if (r.exitCode !== 0) return MISSING.test(r.stderr) ? 'missing' : null
    let out = lines(r)
    if (out.length === 0) return null
    if (!out.every(isAbsolute)) {
      r = await call(this.d.run, [...base, '--show-toplevel', '--git-common-dir'])
      if (r.exitCode !== 0) return MISSING.test(r.stderr) ? 'missing' : null
      out = lines(r)
      if (!out[0] || !isAbsolute(out[0])) return null
    }
    const top = normPath(out[0]!)
    const c = out[1]
    return { top, common: c ? (isAbsolute(c) ? normPath(c) : joinPath(dir, c)) : `${top}/.git` }
  }

  /**
   * An answer, or 'retry' (no answer: the breaker is open or git could not run). Only an execution fault counts
   * against the breaker. A non-zero exit is a normal answer. The record is raw: the caller decides what is "own".
   */
  private async resolveDir(dir: string, env: Env | undefined): Promise<Answer | 'retry'> {
    const now = this.d.now()
    if (!this.breaker.allows(now)) return 'retry'
    let probe: Awaited<ReturnType<RepoTracker['probeDir']>>
    try {
      probe = await this.probeDir(dir)
    } catch {
      this.breaker.failure(now)
      return 'retry'
    }
    if (probe === 'missing') {
      this.breaker.success()
      return 'missing'
    }
    // rev-parse gives a real path, so this also catches a symlink into a noise directory.
    if (!probe || isNoisePath(probe.top, env)) {
      this.breaker.success()
      return null
    }
    const { top: root, common } = probe
    const found = this.byRoot.get(root)
    if (found) {
      this.breaker.success()
      return found
    }

    let remote = ''
    try {
      const r = await call(this.d.run, ['git', '-C', root, 'remote', 'get-url', 'origin'])
      if (r.exitCode === 0) remote = r.stdout.trim()
    } catch {
      this.breaker.failure(now) // never cache a local identity because of a fault
      return 'retry'
    }
    let branch = ''
    let branchFailed = false
    try {
      const b = await call(this.d.run, ['git', '-C', root, 'branch', '--show-current'])
      if (b.exitCode === 0) branch = b.stdout.trim()
    } catch {
      branchFailed = true
      this.breaker.failure(now) // the branch is optional: go on without it
    }
    if (!branchFailed) this.breaker.success()

    const parsed = remote ? parseRemote(remote) : null
    const id = parsed
      ? { key: remoteKey(parsed), name: `${parsed.owner}/${parsed.repo}` }
      : remote
        ? normalizeRemoteUrl(remote)
        : localIdentity(common)
    const resolved: ResolvedRepo = { ...id, root, common }
    if (branch) resolved.branch = branch
    this.byRoot.set(root, resolved)
    return resolved
  }
}

export function upsertRepoRows(rows: readonly RepoRecord[], visit: RepoVisit & { at: number }): RepoRecord[] {
  const i = rows.findIndex(r => r.key === visit.key)
  if (i < 0) {
    return [
      ...rows,
      {
        key: visit.key,
        name: visit.name,
        ...(visit.root !== undefined ? { root: visit.root } : {}),
        ...(visit.branch !== undefined ? { branch: visit.branch } : {}),
        touchedBy: [visit.touchedBy],
        firstSeen: visit.at,
        lastSeen: visit.at,
      },
    ]
  }
  const cur = rows[i]!
  const touchedBy = cur.touchedBy.includes(visit.touchedBy) ? cur.touchedBy : [...cur.touchedBy, visit.touchedBy]
  const next: RepoRecord = {
    ...cur,
    name: visit.name,
    ...(visit.root !== undefined ? { root: visit.root } : {}),
    ...(visit.branch !== undefined ? { branch: visit.branch } : cur.branch !== undefined ? { branch: cur.branch } : {}),
    touchedBy,
    lastSeen: visit.at,
  }
  if (
    next.name === cur.name &&
    next.root === cur.root &&
    next.branch === cur.branch &&
    next.lastSeen === cur.lastSeen &&
    next.touchedBy.length === cur.touchedBy.length
  )
    return rows as RepoRecord[]
  const out = rows.slice()
  out[i] = next
  return out
}

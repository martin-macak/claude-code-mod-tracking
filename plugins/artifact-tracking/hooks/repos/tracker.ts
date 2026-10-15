import { basename, normPath } from '../auto/porcelain'
import type { RepoRecord, RepoRef, Runner, RunResult } from '../contracts'
import { LIMITS } from '../contracts'
import { resolvePath, splitShell, stripWrappers } from '../process/shell'
import { parseRemote } from '../scan/refs'
import { CircuitBreaker } from '../tools/circuit-breaker'

/** The input field that holds a path, per tool. Only absolute paths count; a relative path has no known base. */
export const TOOL_PATH_FIELDS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path'],
} as const

export const PATH_TOOLS = Object.keys(TOOL_PATH_FIELDS) as (keyof typeof TOOL_PATH_FIELDS)[]

/** How a repo was used. A heuristic: a Bash write without git (`sed -i`, `npm install`, `tee`) counts as read. */
export type RepoMode = 'read' | 'edit'

/** One path of a tool call or Bash command and how it was used. */
export type RepoHit = { path: string; mode: RepoMode }

/** What each path tool does with its path. */
export const TOOL_MODE: Record<keyof typeof TOOL_PATH_FIELDS, RepoMode> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
}

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

/**
 * Git options that take their value as the next word. The `--opt=value` forms need no skip. A `-C` is only a path
 * before the subcommand: `git grep -C3` and `git commit -C HEAD` use the same letter for something else.
 */
export const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
])

/**
 * Git subcommands that change a repo (files, index, refs or config). The one place to tune what counts as edit.
 * `git -C X <one of these>` marks X as edit; any other subcommand is read.
 */
const WRITE_GIT: ReadonlySet<string> = new Set([
  'commit',
  'add',
  'rm',
  'mv',
  'push',
  'pull',
  'checkout',
  'switch',
  'restore',
  'reset',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'stash',
  'tag',
  'apply',
  'am',
  'clean',
  'worktree',
  'init',
  'clone',
])

/** The subcommand of `git`: the first word after it that is not an option. Skips `-C <dir>` and the value options. */
export function gitSubcommand(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (!w.startsWith('-')) return w
    if (w === '-C' || GIT_GLOBAL_VALUE_OPTIONS.has(w)) i++
  }
  return undefined
}

/** The first `-C <path>` or `-C<path>` among the global options of `git`. Stops at the subcommand. */
function parseGitCPath(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (!w.startsWith('-')) return undefined
    if (w === '-C') return words[i + 1]
    if (w.startsWith('-C')) return w.slice(2)
    if (GIT_GLOBAL_VALUE_OPTIONS.has(w)) i++
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

export function extractRepoPathsFromTool(tool: string, input: unknown): RepoHit[] {
  if (!Object.hasOwn(TOOL_PATH_FIELDS, tool)) return []
  if (!input || typeof input !== 'object') return []
  const rec = input as Record<string, unknown>
  const out: RepoHit[] = []
  const name = tool as keyof typeof TOOL_PATH_FIELDS
  for (const field of TOOL_PATH_FIELDS[name]) {
    const v = rec[field]
    if (typeof v === 'string' && v !== '') out.push({ path: v, mode: TOOL_MODE[name] })
  }
  return out
}

/** A word that the shell expands at run time. Its value is unknown here. */
const DYNAMIC = /[$`*?]/
/** `~`, `~name`: a home dir that this parser cannot resolve. `~/x` is fine. */
const HOME_FORM = /^~(?:[^/]|$)/

/** Where `target` leads from `dir`. `undefined` when it cannot be known: `-`, `~`, `~name`, `$VAR`, a glob. */
function moveTo(dir: string | undefined, target: string | undefined): string | undefined {
  if (target === undefined || target === '-' || HOME_FORM.test(target) || DYNAMIC.test(target)) return undefined
  if (target.startsWith('/') || target.startsWith('~/')) return resolvePath(undefined, target)
  return dir ? resolvePath(dir, target) : undefined
}

/**
 * The base directory for a relative path in a Bash command. The session cwd is the cwd of the main loop only: a
 * subagent has its own cwd, which the hook cannot read, so a relative path there has no known base.
 */
export function repoBaseDir(cwd: string | undefined, agentId: string | undefined): string | undefined {
  return agentId === undefined ? cwd : undefined
}

export function parseRepoHintsFromBash(command: string, cwd?: string): { paths: RepoHit[]; repos: RepoRef[] } {
  const paths: RepoHit[] = []
  const repos: RepoRef[] = []
  let dir = cwd
  for (const seg of splitShell(command)) {
    const words = stripWrappers(seg.words).words
    if (words.length === 0) continue
    const head = words[0]!
    if (head === 'popd') {
      dir = undefined
      continue
    }
    if (head === 'cd' || head === 'pushd') {
      // An option is a dash word of two or more characters. A lone `-` is the previous directory.
      const target = words.slice(1).find(w => w === '-' || !w.startsWith('-'))
      dir = moveTo(dir, target)
      if (dir && isAbs(dir)) paths.push({ path: dir, mode: 'read' })
      continue
    }
    if (head === 'git') {
      const sub = gitSubcommand(words)
      const mode: RepoMode = sub !== undefined && WRITE_GIT.has(sub) ? 'edit' : 'read'
      const c = parseGitCPath(words)
      if (c !== undefined) {
        const p = moveTo(dir, c)
        if (p && isAbs(p)) paths.push({ path: p, mode })
      } else if (mode === 'edit' && dir && dir !== cwd && isAbs(dir)) {
        // A write after `cd X`. The session repo itself (dir equal to the start) needs no lookup.
        paths.push({ path: dir, mode })
      }
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
  /** Absolute git common dir. Equal for a repo and its worktrees. Identity only: never stored in a row. */
  common: string
}

type TrackerDeps = {
  run: Runner
  now: () => number
  rootPath?: string
  rootRepo?: RepoRef | null
}

export type RepoVisit = Omit<ResolvedRepo, 'common'> & { branch?: string; touchedBy: string; mode: RepoMode }

/**
 * Every git and sh call runs in `/`: a cwd that is a file or a missing directory would make the spawn itself fail.
 * `LC_ALL=C` keeps git's messages in English, so `MISSING` matches under any locale.
 */
async function call(run: Runner, argv: readonly string[]): Promise<RunResult> {
  return run(argv, { cwd: '/', timeoutMs: LIMITS.gitTimeoutMs, env: { LC_ALL: 'C' } })
}

const MAX_WALK = 4
const MISSING = /cannot change to/i

/** A repo, null (not a repo) or 'missing' (the path does not exist or is a file). */
type Answer = ResolvedRepo | null | 'missing'

const isAbsolute = (p: string): boolean => p.startsWith('/')

function visitOf(r: ResolvedRepo, branch: string | undefined, touchedBy: string, mode: RepoMode): RepoVisit {
  const out: RepoVisit = { key: r.key, name: r.name, touchedBy, mode }
  if (r.root !== undefined) out.root = r.root
  if (branch !== undefined) out.branch = branch
  return out
}

export class RepoTracker {
  private readonly breaker = new CircuitBreaker()
  /** Repos stay for the session. null and 'missing' expire after one tick. */
  private readonly cache = new Map<string, { value: Answer; at: number }>()
  private readonly pending = new Map<string, Promise<Answer | 'retry'>>()
  private readonly byRoot = new Map<string, ResolvedRepo>()
  /**
   * The branch of each root, apart from the cached `ResolvedRepo`. `at` is the last good read (or the first try).
   * A fault keeps the old value and `at`, so the next visit tries again until the breaker opens.
   */
  private readonly branches = new Map<string, { branch?: string; at: number }>()
  private readonly branchPending = new Map<string, Promise<void>>()
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
  async fromRepoRef(ref: RepoRef, touchedBy: string, mode: RepoMode = 'read'): Promise<RepoVisit | null> {
    const key = remoteKey(ref)
    const own = await this.ownIdentity()
    if (own !== null && own !== 'retry' && key === own.key) return null
    const rootKey = this.ownRemoteKey()
    if (rootKey !== undefined && key === rootKey) return null
    if (own === 'retry' && rootKey === undefined) return null
    return { key, name: `${ref.owner}/${ref.repo}`, touchedBy, mode }
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

  async resolvePath(path: string, touchedBy: string, mode: RepoMode = 'read'): Promise<RepoVisit | null> {
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
      if (r !== 'missing') {
        if (!r || this.isOwn(r, own)) return null
        return visitOf(r, r.root === undefined ? undefined : await this.freshBranch(r.root), touchedBy, mode)
      }
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
    return { top, common: c ? (isAbsolute(c) ? normPath(c) : resolvePath(dir, c)) : `${top}/.git` }
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
    this.branches.set(root, branch ? { branch, at: this.d.now() } : { at: this.d.now() })

    const parsed = remote ? parseRemote(remote) : null
    const id = parsed
      ? { key: remoteKey(parsed), name: `${parsed.owner}/${parsed.repo}` }
      : remote
        ? normalizeRemoteUrl(remote)
        : localIdentity(common)
    const resolved: ResolvedRepo = { ...id, root, common }
    this.byRoot.set(root, resolved)
    return resolved
  }

  /**
   * The branch of a known repo, re-read at most once per `LIMITS.tickMs`. It runs inside the queued job, never on the
   * hook path. Parallel visits share one call. A fault (or an open breaker) keeps the old value and `at`.
   * Limit: a detached HEAD prints nothing, so the visit has no branch and `upsertRepoRows` keeps the branch of the
   * row. The row can show a stale branch until the repo is on a branch again.
   */
  private async freshBranch(root: string): Promise<string | undefined> {
    const cur = this.branches.get(root)
    if (cur && this.d.now() - cur.at < LIMITS.tickMs) return cur.branch
    let p = this.branchPending.get(root)
    if (!p) {
      p = (async () => {
        try {
          const now = this.d.now()
          if (!this.breaker.allows(now)) return
          try {
            const b = await call(this.d.run, ['git', '-C', root, 'branch', '--show-current'])
            this.breaker.success()
            const branch = b.exitCode === 0 ? b.stdout.trim() : ''
            this.branches.set(root, branch ? { branch, at: now } : { at: now })
          } catch {
            this.breaker.failure(now)
          }
        } finally {
          this.branchPending.delete(root)
        }
      })()
      this.branchPending.set(root, p)
    }
    await p
    return this.branches.get(root)?.branch
  }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** A row without mode (stored by an older version) reads as read. */
const modeOf = (r: RepoRecord): RepoMode => (r.mode === 'edit' ? 'edit' : 'read')

const sameRow = (a: RepoRecord, b: RepoRecord): boolean =>
  a.name === b.name &&
  modeOf(a) === modeOf(b) &&
  a.root === b.root &&
  a.branch === b.branch &&
  a.firstSeen === b.firstSeen &&
  a.lastSeen === b.lastSeen &&
  sameList(a.touchedBy, b.touchedBy)

/** `cur` and `other` in one row: cur's agents first. The newer record (tie: cur) wins; a missing field never wipes one. */
function mergeRow(cur: RepoRecord, other: RepoRecord): RepoRecord {
  const [older, newer] = other.lastSeen > cur.lastSeen ? [cur, other] : [other, cur]
  const touchedBy = [...new Set([...cur.touchedBy, ...other.touchedBy])]
  const defined = Object.fromEntries(Object.entries(newer).filter(([, v]) => v !== undefined))
  const next: RepoRecord = {
    ...older,
    ...defined,
    touchedBy: sameList(touchedBy, cur.touchedBy) ? cur.touchedBy : touchedBy,
    firstSeen: Math.min(cur.firstSeen, other.firstSeen),
    lastSeen: Math.max(cur.lastSeen, other.lastSeen),
  }
  if (modeOf(cur) === 'edit' || modeOf(other) === 'edit') next.mode = 'edit'
  return sameRow(next, cur) ? cur : next
}

/**
 * Merge stored or carried rows into the live list by key. firstSeen is the minimum, lastSeen the maximum, the agents
 * a union (cur first). The row with the greater lastSeen (tie: cur) gives name, root and branch; a missing root or
 * branch never wipes a known one. Edit wins over read, whatever the order. Returns `cur` itself when nothing changes.
 */
export function mergeRepoRows(cur: RepoRecord[], added: readonly RepoRecord[]): RepoRecord[] {
  if (added.length === 0) return cur
  let out = cur
  for (const row of added) {
    const i = out.findIndex(r => r.key === row.key)
    if (i < 0) {
      out = [...out, row]
      continue
    }
    const merged = mergeRow(out[i]!, row)
    if (merged === out[i]) continue
    out = out.slice()
    out[i] = merged
  }
  return out
}

/** Keeps the `LIMITS.maxRepos` rows with the greatest lastSeen (in their order) and the first `maxRepoAgents` agents of each. */
export function capRepoRows(rows: RepoRecord[]): RepoRecord[] {
  let out = rows
  if (out.length > LIMITS.maxRepos) {
    const keep = new Set(
      out
        .map((r, i) => ({ i, at: r.lastSeen }))
        .sort((a, b) => b.at - a.at || b.i - a.i)
        .slice(0, LIMITS.maxRepos)
        .map(x => x.i),
    )
    out = out.filter((_, i) => keep.has(i))
  }
  if (out.some(r => r.touchedBy.length > LIMITS.maxRepoAgents))
    out = out.map(r =>
      r.touchedBy.length > LIMITS.maxRepoAgents ? { ...r, touchedBy: r.touchedBy.slice(0, LIMITS.maxRepoAgents) } : r,
    )
  return out
}

/**
 * Record one visit. An older visit never moves the name, root, branch or lastSeen of a newer row. A visit within
 * `LIMITS.tickMs` of lastSeen leaves lastSeen alone, so a burst of tool calls is one write. A ref visit (no root)
 * does not rename a row that git already named. Edit wins over read, whatever the age of the visit. Returns `rows` itself when no field changes.
 */
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
        mode: visit.mode,
        touchedBy: [visit.touchedBy],
        firstSeen: visit.at,
        lastSeen: visit.at,
      },
    ]
  }
  const cur = rows[i]!
  const touchedBy = cur.touchedBy.includes(visit.touchedBy) ? cur.touchedBy : [...cur.touchedBy, visit.touchedBy]
  const mode: RepoMode = modeOf(cur) === 'edit' || visit.mode === 'edit' ? 'edit' : 'read'
  const next: RepoRecord = { ...cur, touchedBy, mode, firstSeen: Math.min(cur.firstSeen, visit.at) }
  if (visit.at >= cur.lastSeen) {
    if (visit.root !== undefined) next.root = visit.root
    if (visit.branch !== undefined) next.branch = visit.branch
    if (visit.root !== undefined || cur.name === '') next.name = visit.name
    if (visit.at - cur.lastSeen >= LIMITS.tickMs) next.lastSeen = visit.at
  }
  if (sameRow(next, cur)) return rows as RepoRecord[]
  const out = rows.slice()
  out[i] = next
  return out
}

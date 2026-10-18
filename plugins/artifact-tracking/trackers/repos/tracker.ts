import { CircuitBreaker } from '../../core/lib/circuit-breaker'
import { GLOBAL_DEFAULTS } from '../../core/lib/global-config'
import { normPath } from '../../core/lib/porcelain'
import { resolvePath } from '../../core/lib/shell'
import type { RepoRef, Runner, RunResult } from '../../hooks/contracts'
import { parseRemote } from '../../hooks/scan/refs'
import { REPOS_DEFAULTS } from './config'
import type { RepoMode } from './hints'
import { type Env, isNoisePath, localIdentity, normalizeRemoteUrl, remoteKey } from './identity'
import { cleanPath, isAbs, maybeDir, within } from './paths'

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
  /**
   * The git timeout (`trackers.repos.gitTimeoutMs`) and how long a cached answer lives (`global.refresh.tickMs`), read
   * at each use. Absent: today's numbers.
   */
  limits?: () => { gitTimeoutMs: number; tickMs: number }
  /** `global.tools.breaker`, read once per load: the tracker builds its breaker from it. Absent: the default numbers. */
  breakerLimits?: { threshold: number; openMs: number }
}

export type RepoVisit = Omit<ResolvedRepo, 'common'> & { branch?: string; touchedBy: string; mode: RepoMode }

/**
 * Every git and sh call runs in `/`: a cwd that is a file or a missing directory would make the spawn itself fail.
 * `LC_ALL=C` keeps git's messages in English, so `MISSING` matches under any locale.
 */
async function call(run: Runner, argv: readonly string[], timeoutMs: number): Promise<RunResult> {
  return run(argv, { cwd: '/', timeoutMs, env: { LC_ALL: 'C' } })
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
  private readonly breaker: CircuitBreaker
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

  constructor(private readonly d: TrackerDeps) {
    this.breaker = new CircuitBreaker(d.breakerLimits?.threshold, d.breakerLimits?.openMs)
  }

  private get limits(): { gitTimeoutMs: number; tickMs: number } {
    return this.d.limits?.() ?? { gitTimeoutMs: REPOS_DEFAULTS.gitTimeoutMs, tickMs: GLOBAL_DEFAULTS.refresh.tickMs }
  }

  /** One git or sh call, with the timeout the config says now. */
  private git(argv: readonly string[]): Promise<RunResult> {
    return call(this.d.run, argv, this.limits.gitTimeoutMs)
  }

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
      const r = await this.git(['sh', '-c', 'printf "%s\\n%s\\n%s\\n" "$HOME" "$TMPDIR" "$CLAUDE_CONFIG_DIR"'])
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

  async resolvePath(
    path: string,
    touchedBy: string,
    mode: RepoMode = 'read',
    opts: { branchMayChange?: boolean } = {},
  ): Promise<RepoVisit | null> {
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
        return visitOf(
          r,
          r.root === undefined ? undefined : await this.freshBranch(r.root, opts.branchMayChange === true),
          touchedBy,
          mode,
        )
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
      if (this.d.now() - hit.at < this.limits.tickMs) return hit.value
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
    let r = await this.git([...base, '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
    if (r.exitCode !== 0) return MISSING.test(r.stderr) ? 'missing' : null
    let out = lines(r)
    if (out.length === 0) return null
    if (!out.every(isAbsolute)) {
      r = await this.git([...base, '--show-toplevel', '--git-common-dir'])
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
      const r = await this.git(['git', '-C', root, 'remote', 'get-url', 'origin'])
      if (r.exitCode === 0) remote = r.stdout.trim()
    } catch {
      this.breaker.failure(now) // never cache a local identity because of a fault
      return 'retry'
    }
    let branch = ''
    let branchFailed = false
    try {
      const b = await this.git(['git', '-C', root, 'branch', '--show-current'])
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
   * The branch of a known repo, re-read at most once per `tickMs`. It runs inside the queued job, never on the
   * hook path. Parallel visits share one call. A fault (or an open breaker) keeps the old value and `at`.
   * `force` skips the TTL: the command that caused the visit (`git checkout`) has ended and may have moved HEAD. A
   * call that started before the command ended may be stale, so a forced read waits for it and then reads again.
   * Limit: a detached HEAD prints nothing, so the visit has no branch and `upsertRepoRows` keeps the branch of the
   * row. The row can show a stale branch until the repo is on a branch again.
   */
  private async freshBranch(root: string, force = false): Promise<string | undefined> {
    if (force) await this.branchPending.get(root)
    const cur = this.branches.get(root)
    if (!force && cur && this.d.now() - cur.at < this.limits.tickMs) return cur.branch
    let p = this.branchPending.get(root)
    if (!p) {
      p = (async () => {
        try {
          const now = this.d.now()
          if (!this.breaker.allows(now)) return
          try {
            const b = await this.git(['git', '-C', root, 'branch', '--show-current'])
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

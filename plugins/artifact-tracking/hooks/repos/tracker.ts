import { basename, normPath } from '../auto/porcelain'
import type { RepoRecord, RepoRef, Runner, RunResult } from '../contracts'
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

function localKey(root: string): string {
  return `local:${normPath(root)}`
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

export function isNoisePath(path: string): boolean {
  const p = lower(path)
  return (
    p.startsWith('/tmp/') ||
    p === '/tmp' ||
    p.startsWith('/private/tmp/') ||
    p.includes('/node_modules/') ||
    p.endsWith('/node_modules') ||
    p.includes('/scratchpad') ||
    p.startsWith('~/.claude') ||
    p.includes('/.claude/plugins/') ||
    p.includes('/.claude/cache/')
  )
}

type ResolvedRepo = {
  key: string
  name: string
  root?: string
  branch?: string
}

type TrackerDeps = {
  run: Runner
  now: () => number
  rootPath?: string
  rootRepo?: RepoRef | null
}

export type RepoVisit = ResolvedRepo & { touchedBy: string }

async function call(run: Runner, argv: readonly string[], cwd: string): Promise<RunResult> {
  return run(argv, { cwd })
}

export class RepoTracker {
  private readonly breaker = new CircuitBreaker()
  private readonly cache = new Map<string, ResolvedRepo | null>()
  private readonly byRoot = new Map<string, ResolvedRepo>()
  private home: Promise<string | null> | undefined

  constructor(private readonly d: TrackerDeps) {}

  private ownRemoteKey(): string | undefined {
    return this.d.rootRepo ? remoteKey(this.d.rootRepo) : undefined
  }

  private isOwnRepo(r: ResolvedRepo): boolean {
    const root = this.d.rootPath ? normPath(this.d.rootPath) : undefined
    if (root && r.root) {
      const here = normPath(r.root)
      if (here === root) return true
      if (here.startsWith(`${root}/.claude/worktrees/`)) return true
    }
    const own = this.ownRemoteKey()
    return own !== undefined && r.key === own
  }

  fromRepoRef(ref: RepoRef, touchedBy: string): RepoVisit | null {
    const out: RepoVisit = {
      key: remoteKey(ref),
      name: `${ref.owner}/${ref.repo}`,
      touchedBy,
    }
    return this.isOwnRepo(out) ? null : out
  }

  /** `~/x` to an absolute path. `run` gets an argv, so no shell expands the tilde. Cached after the first answer. */
  private async expandHome(path: string): Promise<string | null> {
    if (!path.startsWith('~/')) return path
    if (this.home === undefined) {
      this.home = (async () => {
        try {
          const r = await call(this.d.run, ['sh', '-c', 'printf %s "$HOME"'], '/')
          const h = r.exitCode === 0 ? r.stdout.trim() : ''
          return h.startsWith('/') ? cleanPath(h) : null
        } catch {
          return null
        }
      })()
    }
    const home = await this.home
    return home === null ? null : normPath(`${home}/${path.slice(2)}`)
  }

  async resolvePath(path: string, touchedBy: string): Promise<RepoVisit | null> {
    if (!isAbs(path) || isNoisePath(path)) return null
    const abs = await this.expandHome(path)
    if (abs === null) return null
    const dir = maybeDir(abs)
    const r = await this.lookup(dir)
    if (r) return { ...r, touchedBy }
    // A file without an extension (README, Makefile) looks like a directory. `git -C <file>` fails: try its parent.
    const parent = dir.slice(0, dir.lastIndexOf('/')) || '/'
    if (dir !== '/' && parent !== dir && this.cache.get(dir) === null) {
      const up = await this.lookup(parent)
      if (up) return { ...up, touchedBy }
    }
    return null
  }

  /** Cached answer for a directory. An answer that is only "not now" (breaker open, git fault) is never cached. */
  private async lookup(dir: string): Promise<ResolvedRepo | null> {
    const cached = this.cache.get(dir)
    if (cached !== undefined) return cached
    const r = await this.resolveDir(dir)
    if (r === 'retry') return null
    this.cache.set(dir, r)
    return r
  }

  /**
   * A repo, null (git answered: not a repo, or the session's own repo), or 'retry' (no answer: the breaker is open or
   * git could not run). Only an execution fault counts against the breaker. A non-zero exit is a normal answer.
   */
  private async resolveDir(dir: string): Promise<ResolvedRepo | null | 'retry'> {
    const now = this.d.now()
    if (!this.breaker.allows(now)) return 'retry'
    let root = ''
    try {
      const top = await call(this.d.run, ['git', '-C', dir, 'rev-parse', '--show-toplevel'], dir)
      root = top.exitCode === 0 ? normPath(top.stdout.trim()) : ''
    } catch {
      this.breaker.failure(now)
      return 'retry'
    }
    this.breaker.success()
    if (!root) return null
    const found = this.byRoot.get(root)
    if (found) return found

    let remote = ''
    let branch = ''
    try {
      const r = await call(this.d.run, ['git', '-C', root, 'remote', 'get-url', 'origin'], root)
      if (r.exitCode === 0) remote = r.stdout.trim()
    } catch {
      // keep local identity
    }
    try {
      const b = await call(this.d.run, ['git', '-C', root, 'branch', '--show-current'], root)
      if (b.exitCode === 0) branch = b.stdout.trim()
    } catch {
      // optional field
    }

    const parsed = remote ? parseRemote(remote) : null
    const resolved: ResolvedRepo = parsed
      ? { key: remoteKey(parsed), name: `${parsed.owner}/${parsed.repo}`, root }
      : remote
        ? { key: `remote:${lower(remote)}`, name: basename(root), root }
        : { key: localKey(root), name: basename(root), root }
    if (branch) resolved.branch = branch
    if (this.isOwnRepo(resolved)) return null
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

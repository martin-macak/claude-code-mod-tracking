import type { RepoRef } from '../contracts'
import { resolvePath, scopedDir, splitShell, stripWrappers } from '../process/shell'
import { isAbs, lower } from './paths'

/**
 * The input field that holds a path, per tool. An absolute path always counts. A relative path counts only in the
 * main loop, where the session cwd is its base. A subagent has its own cwd, which the hook cannot read.
 */
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

/**
 * One path of a tool call or Bash command and how it was used. `branchMayChange` marks a command that can have moved
 * HEAD (`git checkout`, `git switch`): the lookup must re-read the branch and skip its cache.
 */
export type RepoHit = { path: string; mode: RepoMode; branchMayChange?: true }

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

/** A path segment with a glob character. */
const GLOB_CHAR = /[*?[{]/

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

/** Git subcommands that move HEAD to another branch. Their repo needs a fresh branch read at once. */
const BRANCH_GIT: ReadonlySet<string> = new Set(['checkout', 'switch'])

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

/** The literal head of an absolute glob pattern: the segments before the first one with a glob character. */
function globPrefix(pattern: string): string | undefined {
  if (!pattern.startsWith('/') && !pattern.startsWith('~/')) return undefined
  const head: string[] = []
  for (const seg of pattern.split('/')) {
    if (GLOB_CHAR.test(seg)) break
    head.push(seg)
  }
  const prefix = head.join('/')
  return prefix === '' || prefix === '/' || prefix === '~' ? undefined : prefix
}

/**
 * The paths of a file-tool call. A relative path resolves from `base`, the cwd of the caller. With no `base` it stays
 * as it is, and the lookup drops it. A `Glob` with no `path` and an absolute pattern uses the literal head of the
 * pattern: `/x/sdk/**\/*.ts` is `/x/sdk`.
 */
export function extractRepoPathsFromTool(tool: string, input: unknown, base?: string): RepoHit[] {
  if (!Object.hasOwn(TOOL_PATH_FIELDS, tool)) return []
  if (!input || typeof input !== 'object') return []
  const rec = input as Record<string, unknown>
  const out: RepoHit[] = []
  const name = tool as keyof typeof TOOL_PATH_FIELDS
  for (const field of TOOL_PATH_FIELDS[name]) {
    const v = rec[field]
    if (typeof v === 'string' && v !== '') {
      const abs = v.startsWith('/') || v.startsWith('~') || base === undefined ? v : resolvePath(base, v)
      out.push({ path: abs, mode: TOOL_MODE[name] })
    }
  }
  if (name === 'Glob' && out.length === 0 && typeof rec.pattern === 'string') {
    const prefix = globPrefix(rec.pattern)
    if (prefix !== undefined) out.push({ path: prefix, mode: TOOL_MODE[name] })
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
  // A cd moves only its own subshell and the ones inside it.
  const dirs = scopedDir(cwd)
  for (const seg of splitShell(command)) {
    const words = stripWrappers(seg.words).words
    if (words.length === 0) continue
    const head = words[0]!
    let dir = dirs.get(seg.scope)
    if (head === 'popd') {
      dirs.set(seg.scope, undefined)
      continue
    }
    if (head === 'cd' || head === 'pushd') {
      // An option is a dash word of two or more characters. A lone `-` is the previous directory.
      const target = words.slice(1).find(w => w === '-' || !w.startsWith('-'))
      dir = moveTo(dir, target)
      dirs.set(seg.scope, dir)
      if (dir && isAbs(dir)) paths.push({ path: dir, mode: 'read' })
      continue
    }
    if (head === 'git') {
      const sub = gitSubcommand(words)
      const mode: RepoMode = sub !== undefined && WRITE_GIT.has(sub) ? 'edit' : 'read'
      const moves = sub !== undefined && BRANCH_GIT.has(sub)
      const hit = (path: string): RepoHit => (moves ? { path, mode, branchMayChange: true } : { path, mode })
      const c = parseGitCPath(words)
      if (c !== undefined) {
        const p = moveTo(dir, c)
        if (p && isAbs(p)) paths.push(hit(p))
      } else if (mode === 'edit' && dir && dir !== cwd && isAbs(dir)) {
        // A write after `cd X`. The session repo itself (dir equal to the start) needs no lookup.
        paths.push(hit(dir))
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

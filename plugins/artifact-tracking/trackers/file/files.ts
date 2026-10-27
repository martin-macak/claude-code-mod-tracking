// File facts (issues #28 and #57): what a Read, Write, Edit, NotebookEdit or Bash result says, which paths a text names, which
// paths the mod ignores. Pure: no `$`, no I/O. register.tsx resolves and stats the paths.

import { isRecord } from '../../core/lib/json'
import { isAbsolutePath, normalizePath, relativeToRoot } from '../../core/lib/paths'
import { FILE_DEFAULTS, type FileConfig } from './config'
import { typeOfName } from './file-type'
import type { FileActivity } from './types'

const MD = /[^/\\]\.md$/i

/** True for a `.md` path, in any case: the paths that `scope: "md"` keeps (issue #28). */
export const isMd = (path: string): boolean => MD.test(path)

/** A path that a tool touched, as the tool spelled it, and how it touched it. */
export type FileTouch = { spelled: string; kind: Exclude<FileActivity, 'mentioned'> }

/** An absolute, normalized path: `~/` joins `home`, a relative path joins `cwd`. null: `~/` with no home. */
export function resolvePath(path: string, cwd: string, home?: string): string | null {
  if (path.startsWith('~/')) return home ? normalizePath(`${home}/${path.slice(2)}`) : null
  return normalizePath(isAbsolutePath(path) ? path : `${cwd}/${path}`)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * The file a Read, Write, Edit or NotebookEdit call touched, of any type (issue #57). `ran` is what `await next(e)` gave, or
 * a transcript tool use (the same `result` and `isError` fields). `input` is the tool input: a Read of an image answers with
 * no path, so the path comes from `input.file_path`. null: a failed, denied or staged call, a tool that is no file tool, or an
 * answer with no usable path (a NotebookEdit whose `error` is a message).
 *
 * - Read: every result type that names its file (`text`, `file_unchanged`, `notebook`, `pdf`, `parts`) is a view, and so is an
 *   `image`, by its input. A repeated Read of a file that did not change answers `file_unchanged` (issue #245).
 * - Write: type `create` made the file, any other type updated it. Edit and NotebookEdit edit it.
 */
export function touchFromToolResult(tool: string, ran: unknown, input?: unknown): FileTouch | null {
  if (!isRecord(ran) || ran.isError === true) return null
  const r = ran.result
  if (!isRecord(r) || r.staged === true) return null
  switch (tool) {
    case 'Read': {
      const spelled =
        (isRecord(r.file) ? str(r.file.filePath) : undefined) ??
        (r.type === 'image' ? str(inputPath(input)) : undefined)
      return spelled === undefined ? null : { spelled, kind: 'viewed' }
    }
    case 'Write': {
      const spelled = str(r.filePath)
      return spelled === undefined ? null : { spelled, kind: r.type === 'create' ? 'created' : 'edited' }
    }
    case 'Edit': {
      const spelled = str(r.filePath)
      return spelled === undefined ? null : { spelled, kind: 'edited' }
    }
    case 'NotebookEdit': {
      // A success has `error: ""`. A failure is a string with `isError`, which the check above caught; a message here is one too.
      const spelled = r.error === undefined || r.error === '' ? str(r.notebook_path) : undefined
      return spelled === undefined ? null : { spelled, kind: 'edited' }
    }
    default:
      return null
  }
}

/** The `file_path` of a tool input. */
const inputPath = (input: unknown): unknown => (isRecord(input) ? input.file_path : undefined)

/** Where the ignore rule looks, all absolute: the session root, the Claude config dir, the `autoMemoryDirectory`. */
export type IgnoreContext = { root?: string; configDir?: string; memoryDir?: string }

const SKIPPED = new Set(['.git', 'node_modules'])
const hasSkipped = (parts: readonly string[]): boolean => parts.some(p => SKIPPED.has(p.toLowerCase()))

/** The engine's scratchpad: `claude-<uid>/<slug>/<session>/scratchpad/…`, under any temp base. */
function inScratchpad(parts: readonly string[]): boolean {
  for (let i = 3; i < parts.length - 1; i++)
    if (parts[i] === 'scratchpad' && /^claude-\d+$/.test(parts[i - 3]!)) return true
  return false
}

/**
 * The fixed ignore rule (README, "Files"). Ignored: a `.git` or `node_modules` folder, auto-memory under
 * `<configDir>/projects/<project>/memory/` or under the `autoMemoryDirectory` setting, and the Claude scratchpad.
 * Below the session root, only `.git` and `node_modules` below the root count, so a project inside such a folder
 * keeps its files.
 */
export function isIgnored(path: string, ctx: IgnoreContext): boolean {
  const abs = normalizePath(path)
  if (ctx.memoryDir && relativeToRoot(abs, ctx.memoryDir) !== abs) return true
  if (ctx.configDir) {
    const projects = `${normalizePath(ctx.configDir)}/projects/`
    if (abs.startsWith(projects)) {
      const rest = abs.slice(projects.length).split('/')
      if (rest.length > 2 && rest[1] === 'memory') return true
    }
  }
  if (ctx.root) {
    const below = relativeToRoot(abs, ctx.root)
    if (below !== abs) return hasSkipped(below.split('/'))
  }
  const parts = abs.split('/').filter(Boolean)
  return hasSkipped(parts) || inScratchpad(parts)
}

const SPLIT = /[\s()[\]<>"'`*|,;]+/
const SUFFIX = /(?:#[^#]*|:\d+(?:[:-]\d+)?)$/
/** The longest token that is read as a path. A longer word is no path, and a stat of it costs more than it can win. */
const TOKEN_MAX = 512

/**
 * True when a word of a text may be a path (issue #57, R2): it ends in an extension or a name of the type map (`a.ts`,
 * `Makefile`, `.env`), or it is written as a path: it starts with `./`, `../`, `~/` or `/` and a folder, or it holds a `/` and
 * its last part has an extension of any kind (`src/a.weird`). A relative path with no extension (`bin/deploy`) is no candidate
 * unless it has a lead (`./bin/deploy`): the stat budget is kept for words that look like a file. A word like `e.g`,
 * `v2.1.310` or `example.com` ends in no known extension and costs no stat; `Next.js` does and costs one. A pair of words
 * (`and/or`), a repo (`acme/web#5`, `src/core`), a slash command (`/track`) and a date or a fraction (`1/2`) are no paths.
 * The stat decides the rest: a path that is not a file adds no row.
 */
function isPathLike(token: string): boolean {
  if (token.length > TOKEN_MAX || token.endsWith('/')) return false
  if (typeOfName(token) !== undefined) return true
  if (!token.includes('/')) return false
  if (/^(?:\.{1,2}|~)\/./.test(token)) return true
  if (token.startsWith('/')) return token.indexOf('/', 1) > 0
  return /[^/]\.[\w-]+$/.test(token) && !/^[\d/.]+$/.test(token)
}

/**
 * Paths that a prompt or a reply names, as spelled, unique, at most `max`: with `scope: "md"` only `.md` paths (issue #28), with
 * `"all"` every word that may be a path (`isPathLike`). A URL is skipped. A trailing line number (`a.ts:42`), anchor (`a.md#L7`)
 * or punctuation and a leading `@` are cut.
 */
export function pathCandidates(
  text: string,
  max: number = FILE_DEFAULTS.maxMentionsPerRow,
  scope: FileConfig['scope'] = 'all',
): string[] {
  const out: string[] = []
  if (max <= 0) return out // `maxMentionsPerRow: 0` turns the mentions off
  for (const raw of text.split(SPLIT)) {
    if (raw.includes('://')) continue
    const token = raw
      .replace(/^@/, '')
      .replace(/[.:!?]+$/, '')
      .replace(SUFFIX, '')
      .replace(/[.:!?]+$/, '')
    if (token === '' || out.includes(token) || !(scope === 'md' ? isMd(token) : isPathLike(token))) continue
    out.push(token)
    if (out.length >= max) break
  }
  return out
}

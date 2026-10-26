// Markdown file facts (issue #28): what a Write, Edit or Read result says, which paths a text names, which paths
// the mod ignores. Pure: no `$`, no I/O. register.tsx resolves and stats the paths.

import { isRecord } from '../../core/lib/json'
import { isAbsolutePath, normalizePath, relativeToRoot } from '../../core/lib/paths'
import { FILE_DEFAULTS } from './config'
import type { FileActivity } from './types'

const MD = /[^/\\]\.md$/i

/** A path that a tool touched, as the tool spelled it, and how it touched it. */
export type FileTouch = { spelled: string; kind: Exclude<FileActivity, 'mentioned'> }

/** An absolute, normalized path: `~/` joins `home`, a relative path joins `cwd`. null: `~/` with no home. */
export function resolvePath(path: string, cwd: string, home?: string): string | null {
  if (path.startsWith('~/')) return home ? normalizePath(`${home}/${path.slice(2)}`) : null
  return normalizePath(isAbsolutePath(path) ? path : `${cwd}/${path}`)
}

/** The `Read` result types that count as a view and name the file in `file.filePath`. */
const VIEW_TYPES: ReadonlySet<unknown> = new Set(['text', 'file_unchanged'])

/**
 * The Markdown file a Write, Edit or Read call touched. `ran` is what `await next(e)` gave, or a transcript tool
 * use (the same `result` and `isError` fields). null: a failed, denied or staged call, or no `.md` path.
 */
export function touchFromToolResult(tool: string, ran: unknown): FileTouch | null {
  if (!isRecord(ran) || ran.isError === true) return null
  const r = ran.result
  if (!isRecord(r) || r.staged === true) return null
  // A repeated Read of a file that did not change answers `file_unchanged`: it is a view as well (issue #245).
  const path = tool === 'Read' ? (VIEW_TYPES.has(r.type) && isRecord(r.file) ? r.file.filePath : undefined) : r.filePath
  if (typeof path !== 'string' || !MD.test(path)) return null
  if (tool === 'Read') return { spelled: path, kind: 'viewed' }
  if (tool === 'Write') return { spelled: path, kind: r.type === 'create' ? 'created' : 'edited' }
  if (tool === 'Edit') return { spelled: path, kind: 'edited' }
  return null
}

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
 * The fixed ignore rule (README, "Markdown files"). Ignored: a `.git` or `node_modules` folder, auto-memory under
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

/**
 * `.md` paths that a prompt or a reply names, as spelled, unique, at most `max`. A URL is skipped. A trailing line
 * number (`a.md:42`), anchor (`a.md#L7`) or punctuation and a leading `@` are cut.
 */
export function mdCandidates(text: string, max: number = FILE_DEFAULTS.maxMentionsPerRow): string[] {
  const out: string[] = []
  if (max <= 0) return out // `maxMentionsPerRow: 0` turns the mentions off
  for (const raw of text.split(SPLIT)) {
    if (raw.includes('://')) continue
    const token = raw
      .replace(/^@/, '')
      .replace(/[.:!?]+$/, '')
      .replace(SUFFIX, '')
      .replace(/[.:!?]+$/, '')
    if (!MD.test(token) || out.includes(token)) continue
    out.push(token)
    if (out.length >= max) break
  }
  return out
}

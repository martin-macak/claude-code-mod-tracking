// Reference extraction: text -> GitHub, Jira, artifact and web refs (spec section 6.1).
// Pure code. No `$`, no I/O. Every regex is linear. Input is capped at MAX_TEXT before any regex runs.

import type { ExtractOptions, GitHubRef, JiraRef, Ref, RepoRef, WebRef } from '../contracts'
import { JIRA_KEY } from '../contracts'
import { keyOf } from '../model/keys'
import { parseArtifactUrl } from './artifact-url'
import { MAX_TEXT, normalizeUrl, scanMarkdown, schemeOf } from './links'

const MAX_REMOTE = 2048
const MAX_LABEL = 60
const FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|md|py|go|rs|java|kt|rb|json|ya?ml|toml|txt|html|css|sh)$/i
const GH_PATH = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/
const BARE_REF = /(?<![\w/&#])#(\d{1,7})\b/g
const URL_RUN = /https?:\/\/[^\s<>"'`\][(){}]+/g
const TRAILING = '.,;:!?*_~'
// Conversation short refs are narrow by design (issue #8): only these lead words opt in `#N` capture.
const SHORT_REF_PREFIX = /\b(?:github|bug|issue|issues|enhancement|chore)\s*[-:() ]*$/i
/** A web URL longer than this is not tracked. It would bloat $.state and $.store. */
const MAX_WEB_URL = 2048

const cap = (text: string): string => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text)

/** Cut trailing characters of `chars` from `s`. A backward loop: linear, unlike `/[…]+$/`. */
function trimEnd(s: string, chars: string): string {
  let e = s.length
  while (e > 0 && chars.includes(s[e - 1]!)) e--
  return s.slice(0, e)
}

// ---------------------------------------------------------------- parsers

/** `owner/repo` of a git remote: scp form, ssh://, https:// (credentials dropped), git://. */
export function parseRemote(remote: string): RepoRef | null {
  if (!remote || remote.length > MAX_REMOTE) return null
  const m =
    /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote) ??
    /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote)
  if (!m) return null
  const scp = !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)
  if (scp && m[1]!.length < 2) return null // `C:/dir/x` is a path, not a host
  const host = m[1]!.toLowerCase()
  return { host: host === 'ssh.github.com' ? 'github.com' : host, owner: m[2]!, repo: m[3]! }
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function parseGitHubUrl(url: string, githubHosts: readonly string[] = []): GitHubRef | null {
  const u = parse(url.trim())
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null
  const seen = u.hostname.toLowerCase()
  const host = seen === 'www.github.com' ? 'github.com' : seen
  const known = host === 'github.com' || githubHosts.some(h => h.toLowerCase() === host)
  if (!known) return null
  const m = GH_PATH.exec(u.pathname + u.search + u.hash)
  if (!m) return null
  const [, owner, repo, kind, n] = m
  const number = Number(n)
  if (!Number.isSafeInteger(number)) return null
  return {
    category: 'github',
    host,
    owner: owner!,
    repo: repo!,
    number,
    type: kind === 'pull' ? 'pr' : 'issue',
    url: `https://${host}/${owner}/${repo}/${kind}/${n}`,
  }
}

export function parseJiraUrl(url: string): JiraRef | null {
  const u = parse(url.trim())
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null
  const site = u.hostname.toLowerCase()
  const cloud = site.endsWith('.atlassian.net')
  const key = jiraKey(u, cloud)
  if (key === null) return null
  return { category: 'jira', site, issueKey: key, url: `https://${site}/browse/${key}`, trackOnly: !cloud }
}

function jiraKey(u: URL, cloud: boolean): string | null {
  const browse = /^\/browse\/([^/]+)\/?$/.exec(u.pathname)
  if (browse && JIRA_KEY.test(browse[1]!)) return browse[1]!
  if (!cloud) return null
  const sel = u.searchParams.get('selectedIssue')
  if (sel !== null && JIRA_KEY.test(sel)) return sel
  const tail = /\/issues\/([^/]+)\/?$/.exec(u.pathname)
  return tail && JIRA_KEY.test(tail[1]!) ? tail[1]! : null
}

// ---------------------------------------------------------------- small helpers

/** Inner text of `<command-args>…</command-args>`, or ''. */
export function commandArgs(text: string): string {
  const t = cap(text)
  const open = t.indexOf('<command-args>')
  if (open === -1) return ''
  const from = open + '<command-args>'.length
  const close = t.indexOf('</command-args>', from)
  return close === -1 ? '' : t.slice(from, close)
}

/** `host/path` of a URL for a label: no scheme, query or trailing slash, at most 60 chars. */
export function hostPath(url: string): string {
  const u = parse(url)
  const raw = u ? u.host + u.pathname : url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const s = trimEnd(raw, '/')
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '\u2026' : s
}

// ---------------------------------------------------------------- masking for bare #N

const blanks = (s: string): string => ' '.repeat(s.length)

/** Blank fenced code blocks (``` and ~~~). An unclosed fence runs to the end. */
function maskFences(text: string): string {
  const lines = text.split('\n')
  let fence: { ch: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && m[2]!.trim() === '') fence = null
      lines[i] = blanks(line)
    } else if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
      fence = { ch: m[1]![0]!, len: m[1]!.length }
      lines[i] = blanks(line)
    }
  }
  return lines.join('\n')
}

/** Blank inline code spans: a backtick run closes at the next run of the same length. Linear. */
function maskCodeSpans(text: string): string {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue
    let j = i
    while (text[j] === '`') j++
    runs.push([i, j - i])
    i = j - 1
  }
  if (runs.length < 2) return text
  const next = new Array<number>(runs.length).fill(-1)
  const last = new Map<number, number>()
  for (let k = runs.length - 1; k >= 0; k--) {
    const len = runs[k]![1]
    next[k] = last.get(len) ?? -1
    last.set(len, k)
  }
  let out = ''
  let pos = 0
  for (let k = 0; k < runs.length; k++) {
    const close = next[k]!
    if (close === -1) continue
    const from = runs[k]![0]
    const to = runs[close]![0] + runs[close]![1]
    out += text.slice(pos, from) + blanks(text.slice(from, to))
    pos = to
    k = close // runs inside the span are consumed
  }
  return out + text.slice(pos)
}

/** Replace what a bare `#N` must not be read from with spaces of equal length. */
function maskForBare(text: string): string {
  return maskCodeSpans(maskFences(text))
    .replace(/<[^<>\s]*>/g, blanks)
    .replace(/\]\([^()\n]*\)?/g, blanks)
    .replace(/https?:\/\/\S+/g, blanks)
}

// ---------------------------------------------------------------- extraction

function webRef(url: string, label: string | undefined): WebRef {
  return { category: 'web', url, label: label !== undefined && label !== url ? label : hostPath(url) }
}

function classify(url: string, label: string | undefined, hosts: readonly string[]): Ref {
  return parseGitHubUrl(url, hosts) ?? parseJiraUrl(url) ?? parseArtifactUrl(url, label) ?? webRef(url, label)
}

type At = { pos: number; ref: Ref }

/**
 * Where a found link sits in the text. scanMarkdown gives no offsets, but it lists links in order.
 * So search forward from the last hit. A miss keeps the cursor, so the order stays right.
 */
function locate(text: string, needles: Array<string | undefined>, cursor: number): { pos: number; next: number } {
  for (const n of needles) {
    if (!n) continue
    const i = text.indexOf(n, cursor)
    if (i !== -1) return { pos: i, next: i + n.length }
  }
  return { pos: cursor, next: cursor }
}

function fromMarkdown(
  text: string,
  hosts: readonly string[],
  repo: RepoRef | null | undefined,
  strictShortRefs: boolean,
): At[] {
  const refs: At[] = []
  let cursor = 0
  for (const f of scanMarkdown(text)) {
    if (f.kind !== 'link') continue
    const scheme = schemeOf(f.url)
    if (scheme !== 'http' && scheme !== 'https') continue
    const hit = locate(text, [f.via === 'issue-ref' ? f.label : f.url, f.label], cursor)
    cursor = hit.next
    if (f.via === 'issue-ref') {
      const gh = parseGitHubUrl(f.url)
      const keep = gh && !FILE_EXT.test(gh.repo!) && (!strictShortRefs || shortRefAllowed(text, hit.pos, gh, repo))
      if (keep) {
        refs.push({
          pos: hit.pos,
          ref: { ...gh, type: 'unknown', ...(strictShortRefs ? { short: true as const } : {}) },
        })
      }
      continue
    }
    const ref = classify(f.url, f.label, hosts)
    if (ref.category === 'web' && ref.url.length > MAX_WEB_URL) continue
    refs.push({ pos: hit.pos, ref })
  }
  return refs
}

function sameRepo(a: RepoRef | null | undefined, b: { host: string; owner: string; repo: string }): boolean {
  if (!a) return false
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

function hasShortRefPrefix(text: string, at: number): boolean {
  const from = Math.max(0, at - 64)
  return SHORT_REF_PREFIX.test(text.slice(from, at))
}

function shortRefAllowed(text: string, at: number, ref: GitHubRef, repo: RepoRef | null | undefined): boolean {
  if (!hasShortRefPrefix(text, at)) return false
  if (!ref.owner || !ref.repo) return false
  return sameRepo(repo, { host: ref.host, owner: ref.owner, repo: ref.repo })
}

function bareRefs(text: string, repo: RepoRef | null | undefined, strictShortRefs: boolean): At[] {
  const masked = maskForBare(text)
  const refs: At[] = []
  for (const m of masked.matchAll(BARE_REF)) {
    const number = Number(m[1])
    const ref: GitHubRef = repo
      ? { category: 'github', host: repo.host, owner: repo.owner, repo: repo.repo, number, type: 'unknown' }
      : { category: 'github', host: 'github.com', number, type: 'unknown' }
    if (strictShortRefs && !shortRefAllowed(text, m.index!, ref, repo)) continue
    if (strictShortRefs) ref.short = true
    refs.push({ pos: m.index!, ref })
  }
  return refs
}

function urlsOnly(text: string, hosts: readonly string[]): Ref[] {
  const refs: Ref[] = []
  for (const m of text.matchAll(URL_RUN)) {
    const url = trimEnd(m[0], TRAILING)
    const ref = parseGitHubUrl(url, hosts) ?? parseJiraUrl(url)
    if (ref) refs.push(ref)
  }
  return refs
}

function uniqueKey(r: Ref): string {
  if (r.category === 'github') return `gh:${r.host}/${r.owner ?? ''}/${r.repo ?? ''}#${r.number}`.toLowerCase()
  if (r.category === 'jira') return `jira:${r.site}/${r.issueKey}`.toLowerCase()
  if (r.category === 'artifact') return keyOf(r)
  return 'web:' + normalizeUrl(r.url).replace(/#.*$/s, '')
}

/** Refs found in `text`, unique, in order of appearance. */
export function extractRefs(text: string, opts: ExtractOptions): Ref[] {
  const t = cap(text)
  const hosts = opts.githubHosts ?? []
  const strictShortRefs = opts.strictShortRefs ?? false
  const all =
    opts.mode === 'urls-only'
      ? urlsOnly(t, hosts)
      : [
          ...fromMarkdown(t, hosts, opts.defaultRepo, strictShortRefs),
          ...bareRefs(t, opts.defaultRepo, strictShortRefs),
        ]
          .sort((a, b) => a.pos - b.pos)
          .map(x => x.ref)
  const seen = new Set<string>()
  return all.filter(r => {
    const k = uniqueKey(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

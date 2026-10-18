// What the github kind scans for in a text once the URLs are claimed: `owner/repo#N` and a bare `#N`. Pure: no I/O.
// Moved from `hooks/scan/refs.ts` in plan L5, Task 5 (spec 5.9, capture step 3). In conversation text (`purpose`
// `capture`) a short ref counts only when a lead word prefixes it and it names the session repo (issue #8).

import type { Claim, Json, JsonObject, KindContext, ScanMode } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import { locate, scanMarkdown } from '../../core/lib/links'
import { maskForBare } from '../../core/lib/mask'
import { GITHUB_DEFAULTS } from './config'
import type { GitHubRef } from './types'
import { githubKeyOf, parseGitHubUrl } from './urls'

const FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|md|py|go|rs|java|kt|rb|json|ya?ml|toml|txt|html|css|sh)$/i
const BARE_REF = /(?<![\w/&#])#(\d{1,7})\b/g
const REGEX_CHARS = /[.*+?^${}()|[\]\\]/g

// Conversation short refs are narrow by design (issue #8): only the lead words of `shortRefKeywords` opt in `#N`
// capture. The pattern is built from the list and kept for the next call with the same list; an empty list matches nothing.
let prefixCache: { key: string; pattern: RegExp | null } | undefined

function shortRefPrefix(words: readonly string[]): RegExp | null {
  const list = words.filter(w => w !== '')
  const key = list.join('\n')
  if (prefixCache?.key !== key) {
    const alternatives = list.map(w => w.replace(REGEX_CHARS, '\\$&')).join('|')
    prefixCache = { key, pattern: list.length === 0 ? null : new RegExp(`\\b(?:${alternatives})\\s*[-:() ]*$`, 'i') }
  }
  return prefixCache.pattern
}

function sameRepo(a: RepoRef | null | undefined, b: { host: string; owner: string; repo: string }): boolean {
  if (!a) return false
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

function hasShortRefPrefix(text: string, at: number, prefix: RegExp | null): boolean {
  const from = Math.max(0, at - 64)
  return prefix?.test(text.slice(from, at)) === true
}

function shortRefAllowed(
  text: string,
  at: number,
  ref: GitHubRef,
  repo: RepoRef | null | undefined,
  prefix: RegExp | null,
): boolean {
  if (!hasShortRefPrefix(text, at, prefix)) return false
  if (!ref.owner || !ref.repo) return false
  return sameRepo(repo, { host: ref.host, owner: ref.owner, repo: ref.repo })
}

/** The claim of a ref: seen now, from the source of the text, and where it sits in the text when that is known. */
export function githubClaim(ref: GitHubRef, ctx: KindContext, span?: { start: number; length: number }): Claim {
  const { category, ...fields } = ref
  return {
    category,
    key: githubKeyOf(ref),
    source: ctx.source,
    at: ctx.now,
    ...(span ? { span: { start: span.start, end: span.start + span.length } } : {}),
    fields: fields as unknown as JsonObject,
  }
}

const wordsOf = (ctx: KindContext): readonly string[] => {
  const words: Json | undefined = ctx.config.slice().shortRefKeywords
  return Array.isArray(words) ? (words as readonly string[]) : GITHUB_DEFAULTS.shortRefKeywords
}

/**
 * The refs of `text` that are not URLs: `owner/repo#N`, and a bare `#N` in the session repo (the `session.repo` fact).
 * Nothing in `urls-only` mode, which reads explicit URLs only.
 */
export function scanGitHub(text: string, mode: ScanMode, ctx: KindContext): Claim[] {
  if (mode === 'urls-only') return []
  const strict = ctx.purpose === 'capture'
  const repo = ctx.facts.read<Json>('session.repo') as unknown as RepoRef | null | undefined
  const prefix = strict ? shortRefPrefix(wordsOf(ctx)) : null
  const claims: Claim[] = []

  // `owner/repo#N` in plain text. The scanner reads it as a link to the issue on `github.com`.
  let cursor = 0
  for (const f of scanMarkdown(text, { issueHost: 'github.com' })) {
    if (f.via !== 'issue-ref') continue
    const hit = locate(text, [f.label], cursor)
    cursor = hit.next
    const gh = parseGitHubUrl(f.url)
    if (!gh || FILE_EXT.test(gh.repo!)) continue
    if (strict && !shortRefAllowed(text, hit.pos, gh, repo, prefix)) continue
    const ref: GitHubRef = { ...gh, type: 'unknown', ...(strict ? { short: true as const } : {}) }
    claims.push(githubClaim(ref, ctx, { start: hit.pos, length: hit.length }))
  }

  // A bare `#N`. Without a session repo it is `gh:?#N`, kept only for a lookup.
  for (const m of maskForBare(text).matchAll(BARE_REF)) {
    const number = Number(m[1])
    const ref: GitHubRef = repo
      ? { category: 'github', host: repo.host, owner: repo.owner, repo: repo.repo, number, type: 'unknown' }
      : { category: 'github', host: 'github.com', number, type: 'unknown' }
    if (strict && !shortRefAllowed(text, m.index!, ref, repo, prefix)) continue
    if (strict) ref.short = true
    claims.push(githubClaim(ref, ctx, { start: m.index!, length: m[0].length }))
  }
  return claims
}

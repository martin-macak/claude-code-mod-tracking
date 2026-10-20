// The scan of one text for items: offers each URL to the kinds by rank, masks what they claimed and lets every kind scan
// the rest for its own syntax. Pure: no I/O, no state, no tracker names. Plan: L5 Task 5 (the pure part of Capture; the
// door rules, the async hooks and the merge into the store follow in Task 8).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9, capture steps 1 to 3.

import type { Claim, ItemKind, KindContext, ScanMode } from '../interfaces/items'
import { capText, locate, scanMarkdown, schemeOf, trimEnd } from '../lib/links'
import { maskSpans } from '../lib/mask'

/**
 * What the kinds are given with a text. A `KindContext` carries the config of the tracker that owns the kind, so a
 * caller with several owners passes a function that answers for each kind.
 */
export type KindContexts = KindContext | ((kind: ItemKind) => KindContext)

const URL_RUN = /https?:\/\/[^\s<>"'`\][(){}]+/g
const TRAILING = '.,;:!?*_~'

/** An URL in the text, with its label when it has one, and the span it fills (a Markdown link: the whole link). */
type Candidate = { url: string; label?: string; start: number; end: number }

/** `urls-only`: the explicit URLs of a tool result, trailing punctuation cut. */
function urlRuns(text: string): Candidate[] {
  return [...text.matchAll(URL_RUN)].map(m => {
    const url = trimEnd(m[0], TRAILING)
    return { url, start: m.index!, end: m.index! + url.length }
  })
}

/**
 * `full`: the links of the Markdown scanner with an http or https scheme, located in order. A link written as
 * `[label](url)` fills the whole link, so its label is not read again as plain text; a title after the URL stays.
 */
function markdownLinks(text: string): Candidate[] {
  const out: Candidate[] = []
  let cursor = 0
  for (const f of scanMarkdown(text)) {
    if (f.kind !== 'link') continue
    const scheme = schemeOf(f.url)
    if (scheme !== 'http' && scheme !== 'https') continue
    // Look for the whole `[label](url` first: the URL may also sit earlier in text the scanner skips (code, an image).
    const whole = f.label === undefined ? undefined : `[${f.label}](${f.url}`
    const hit = locate(text, [whole, f.url, f.label], cursor)
    cursor = hit.next
    const start = hit.pos
    let end = hit.pos + hit.length
    if (whole !== undefined && text.startsWith(whole, start) && text[end] === ')') end++
    out.push({ url: f.url, ...(f.label !== undefined ? { label: f.label } : {}), start, end })
  }
  return out
}

/**
 * The claims in `text`, in order of appearance, one per key.
 *
 * 1. The candidates: in `urls-only` mode the explicit URLs, else the Markdown links.
 * 2. Each candidate goes to the kinds by `rank` (ties: the order given); the first `claimUrl` that answers wins. A kind
 *    that does not read tool output (`urls-only`) answers null there, so no fallback claims a bare URL.
 * 3. The claimed spans are blanked, then each kind scans what is left (`scan`), for kind syntax a URL cannot hold.
 *    A kind that throws (in `claimUrl` or `scan`) gives no claim and the others still count. A URL that threw in
 *    `claimUrl` keeps its span, so it does not fall to a later kind.
 * 4. The claims sort by where they sit (one with no span goes last); the first claim of a key stays.
 *
 * `mode` is the caller's, whatever the contexts say. A claim from a kind with no `span` keeps none.
 */
export function scanClaims(text: string, mode: ScanMode, kinds: readonly ItemKind[], ctx: KindContexts): Claim[] {
  const t = capText(text)
  const ordered = [...kinds].sort((a, b) => a.rank - b.rank)
  const contexts = new Map(
    ordered.map(kind => [kind, { ...(typeof ctx === 'function' ? ctx(kind) : ctx), mode }] as const),
  )
  const claims: Claim[] = []
  const spans: { start: number; end: number }[] = []
  for (const c of mode === 'urls-only' ? urlRuns(t) : markdownLinks(t)) {
    for (const kind of ordered) {
      let claim: Claim | null | undefined
      try {
        claim = kind.claimUrl?.(c.url, c.label, contexts.get(kind)!)
      } catch {
        // The kind's fault, for example a reason word that is off: no claim, and the URL does not fall to a later kind.
        spans.push({ start: c.start, end: c.end })
        break
      }
      if (!claim) continue
      claims.push({ ...claim, span: { start: c.start, end: c.end } })
      spans.push({ start: c.start, end: c.end })
      break
    }
  }
  const masked = maskSpans(t, spans)
  for (const kind of ordered) {
    try {
      claims.push(...(kind.scan?.(masked, mode, contexts.get(kind)!) ?? []))
    } catch {
      // One kind's fault must not hide the claims of the others (as `toolCall` does).
    }
  }
  const startOf = (c: Claim): number => c.span?.start ?? Number.MAX_SAFE_INTEGER
  const seen = new Set<string>()
  return claims
    .sort((a, b) => startOf(a) - startOf(b))
    .filter(c => {
      if (seen.has(c.key)) return false
      seen.add(c.key)
      return true
    })
}

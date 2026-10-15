// Claude artifact URLs (issue #29). `/artifact/<id>` and `/code/artifact/<uuid>` name one artifact:
// the id is the UUID in base58 (Bitcoin alphabet). Pure code. No `$`, no I/O.

import type { ArtifactRef } from '../contracts'

const MAX_LABEL = 60
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
// 22 digits hold any 128-bit value. A random UUID has fewer than 16 digits only below 58^15 (about 2^88),
// a chance near 2^-40. So a short segment such as `new` is a page of the site, not an id.
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{16,22}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// One id segment, then at most one slash. The pathname has no query or fragment.
const ARTIFACT_PATH = /^\/(code\/)?artifact\/([^/]+)\/?$/
const LIMIT = 1n << 128n

/** The lower-case UUID of an id segment: a UUID or its base58 form. null: not an artifact id. */
export function artifactUuid(id: string): string | null {
  if (UUID.test(id)) return id.toLowerCase()
  if (!BASE58_ID.test(id)) return null
  let n = 0n
  for (const c of id) n = n * 58n + BigInt(ALPHABET.indexOf(c))
  if (n >= LIMIT) return null
  const h = n.toString(16).padStart(32, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** One line of at most 60 chars: control characters and runs of white space become one space. */
export function clipLabel(text: string): string {
  const s = text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s
}

/**
 * An artifact URL on `claude.ai`, any case, also `www.` and `http:`. Query, fragment and one trailing slash drop.
 * The URL stays in the form it was written: re-encoding a UUID could pick another spelling of the id.
 * The label is `label` (a Markdown label), else the id.
 */
export function parseArtifactUrl(url: string, label?: string): ArtifactRef | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  if (host !== 'claude.ai' && host !== 'www.claude.ai') return null
  const m = ARTIFACT_PATH.exec(u.pathname)
  if (!m) return null
  const id = m[2]!
  const uuid = artifactUuid(id)
  if (!uuid) return null
  const canonical = `https://claude.ai${m[1] ? '/code' : ''}/artifact/${id}`
  const named = label === undefined || label === url ? '' : clipLabel(label)
  return { category: 'artifact', uuid, url: canonical, label: named || id }
}

/** The id segment of a stored artifact URL: the label a row shows when it has no name. */
export const artifactIdOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1)

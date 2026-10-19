// Copied from docs/knowledge-base/claude-code-link-capture/example/link-capture/hooks/links.ts (2026-10-10).
// Keep in sync by hand. The KB page explains each rule.
// Pure link scanner. No `$`, no I/O. Two entry points:
//   scanMarkdown(text)  what the engine's Markdown renderer turns into a link
//   scanOsc8(text)      raw OSC 8 hyperlinks in tool output
// Rules were pinned against Claude Code 2.1.295 (see the KB page, section 3).

import type { Captured, Via } from '../../types'

export type { Captured, Via }

export type Found = {
  url: string
  label?: string
  via: Via
  /** `link`: the renderer or the tool makes a clickable span. `non-clickable`: plain text. */
  kind: 'link' | 'non-clickable'
}

export type ScanOptions = {
  /** Host that `owner/repo#12` points to. Absent: the scan finds no issue references (plan K22). */
  issueHost?: string
}

// ---------------------------------------------------------------- helpers

/** One scan reads at most this many characters. A longer text loses its tail. */
export const MAX_TEXT = 200_000

const MAX_LABEL = 60

/** `text` cut at `MAX_TEXT`. */
export const capText = (text: string): string => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text)

/** Inner text of `<command-args>…</command-args>`, or ''. */
export function commandArgs(text: string): string {
  const t = capText(text)
  const open = t.indexOf('<command-args>')
  if (open === -1) return ''
  const from = open + '<command-args>'.length
  const close = t.indexOf('</command-args>', from)
  return close === -1 ? '' : t.slice(from, close)
}

/**
 * Where a found link sits in the text. `scanMarkdown` gives no offsets, but it lists links in order. So search forward
 * from `cursor` for the first needle that is there. A miss keeps the cursor, so the order stays right.
 */
export function locate(
  text: string,
  needles: ReadonlyArray<string | undefined>,
  cursor: number,
): { pos: number; length: number; next: number } {
  for (const n of needles) {
    if (!n) continue
    const i = text.indexOf(n, cursor)
    if (i !== -1) return { pos: i, length: n.length, next: i + n.length }
  }
  return { pos: cursor, length: 0, next: cursor }
}

/** Cut trailing characters of `chars` from `s`. A backward loop: linear, unlike `/[…]+$/`. */
export function trimEnd(s: string, chars: string): string {
  let e = s.length
  while (e > 0 && chars.includes(s[e - 1]!)) e--
  return s.slice(0, e)
}

/** The host (with the port) and the path of a URL, the path with no trailing slash. Null when `url` does not parse. */
export function urlParts(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url)
    return { host: u.host, path: trimEnd(u.pathname, '/') }
  } catch {
    return null
  }
}

/** `host/path` of a URL for a label: no scheme, query or trailing slash, at most 60 chars. */
export function hostPath(url: string): string {
  const parts = urlParts(url)
  // Not a URL: the label is the text without its scheme.
  const s = parts ? parts.host + parts.path : trimEnd(url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''), '/')
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '\u2026' : s
}

const WEB_SCHEMES = ['http', 'https', 'file']

/** The scheme of a URL, lower case, or '' when it has none. */
export function schemeOf(url: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
  return m ? m[1]!.toLowerCase() : ''
}

export function isWebUrl(url: string): boolean {
  return WEB_SCHEMES.includes(schemeOf(url))
}

/** Dedupe key. Absolute http(s)/file URLs go through `URL`; anything else stays as written. */
export function normalizeUrl(url: string): string {
  const t = url.trim()
  if (!isWebUrl(t)) return t
  try {
    return new URL(t).href
  } catch {
    return t
  }
}

/**
 * The target the renderer hands to the terminal. A destination that starts with a single `/`
 * becomes a `file://` URL with `.` and `..` resolved. `//host/x` is dropped (null). Every other
 * destination is passed on unchanged, whatever its scheme.
 */
export function emittedUrl(href: string): string | null {
  if (href.startsWith('//')) return null
  if (!href.startsWith('/')) return href
  const cut = href.search(/[?#]/)
  const path = cut === -1 ? href : href.slice(0, cut)
  const tail = cut === -1 ? '' : href.slice(cut)
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return 'file:///' + out.join('/') + tail
}

// ---------------------------------------------------------------- block pass

/**
 * Cut the blocks the renderer does not read for links: fenced code, indented code, HTML blocks.
 * Returns the remaining text, with the cut lines emptied.
 */
const HTML_BLOCK_TAGS =
  'address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
const HTML_BLOCK_OPEN = new RegExp(
  '^ {0,3}(?:</?(?:' +
    HTML_BLOCK_TAGS +
    ')(?:[\\s/>]|$)|<(?:script|pre|style|textarea)(?:[\\s>]|$)|<!--|<\\?|<![A-Z]|<!\\[CDATA\\[)',
  'i',
)
const HTML_BLOCK_END: Array<[RegExp, RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Z]/, />/],
]

function stripCodeBlocks(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let fence: RegExp | null = null
  let html: RegExp | 'blank' | null = null
  let prevBlank = true
  let listIndent = -1 // content column of the last list marker; -1 outside a list
  let inIndented = false
  for (const line of lines) {
    if (fence) {
      if (fence.test(line)) fence = null
      out.push('')
      continue
    }
    if (html) {
      if (html === 'blank') {
        const ends = line.trim() === ''
        out.push(ends ? line : '')
        if (ends) html = null
        prevBlank = ends
      } else {
        out.push('')
        if (html.test(line)) html = null
        prevBlank = false
      }
      continue
    }
    const blank = line.trim() === ''
    if (blank) {
      out.push(line)
      prevBlank = true
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = new RegExp('^ {0,3}' + (open[1]![0] === '`' ? '`' : '~') + '{' + open[1]!.length + ',}[ \\t]*$')
      out.push('')
      prevBlank = false
      inIndented = false
      continue
    }
    const indent = /^ */.exec(line.replace(/\t/g, '    '))![0].length
    const codeAt = listIndent < 0 ? 4 : listIndent + 4
    if (indent >= codeAt && (prevBlank || inIndented)) {
      out.push('')
      inIndented = true
      prevBlank = false
      continue
    }
    inIndented = false
    if (indent < 4 && HTML_BLOCK_OPEN.test(line)) {
      const end = HTML_BLOCK_END.find(([start]) => start.test(line))
      html = end ? end[1] : 'blank'
      if (end?.[1].test(line.replace(end[0], ''))) html = null // opened and closed on one line
      out.push('')
      prevBlank = false
      continue
    }
    const marker = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+)/.exec(line)
    if (marker) listIndent = marker[1]!.length + marker[2]!.length + Math.min(marker[3]!.length, 4)
    else if (indent === 0 && !/^ {0,3}>/.test(line)) listIndent = -1
    prevBlank = false
    out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- inline pass

// Sticky regexes: matched at an index, never on a slice. This keeps a scan linear in the text length.
const sticky = (re: RegExp) => new RegExp(re.source, 'y')
function at(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i
  return re.exec(s)
}

const AUTOLINK = sticky(/<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/)
const EMAIL_AUTOLINK = sticky(
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/,
)
// Inline HTML: a tag with quoted attributes, a closing tag, or a comment. The renderer prints it as text.
const HTML_TAG = sticky(
  /(?:<!--[\s\S]*?-->|<\/[a-zA-Z][\w:-]*\s*>|<[a-zA-Z][\w-]*(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/,
)
// Bare URL start, as the GFM literal rule has it: lower-case scheme or `www.`.
const BARE = sticky(/(?:(?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/)
// Trailing-punctuation trim. Applied until the result stops changing.
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/
// `owner/repo#12`. The renderer makes it a link to the host's issue page.
const ISSUE_REF = /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g
const NO_ISSUE_HOSTS = ['bitbucket.org', 'codeberg.org', 'gitea.com', 'git.sr.ht', 'dev.azure.com']
const ANGLE_DEST = sticky(/<((?:\\.|[^\n<>\\])+)>\s*\)/)
const CONTROL = /[\x00-\x1f\x7f]/
const MAX_DEST = 2048 // a longer destination is not read as a link (keeps the scan linear)
const PLAIN_DEST = sticky(/[^\s\x00-\x1f]{0,2048}/)
const TITLED_END = sticky(/\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\))\s*\)/)
const PLAIN_END = sticky(/\s*\)/)
const MAX_BARE = 4096 // a longer candidate is taken whole, without the trim (keeps the trim linear)

function trimBare(raw: string): string {
  if (raw.length > MAX_BARE) return raw
  let s = raw
  for (;;) {
    const next = BACKPEDAL.exec(s)?.[0] ?? ''
    if (next === s) return s
    s = next
  }
}

/** Index of the first unmatched `)`; -1 when none; -2 when a `(` stays open and a `)` exists. */
function findClosingParen(s: string): number {
  if (!s.includes(')')) return -1
  let level = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '(') level++
    else if (c === ')' && --level < 0) return i
  }
  return level > 0 ? -2 : -1
}

/** Code spans and bracket pairs of a text, found in two linear passes. */
type Marks = {
  tickLen: Map<number, number> // start of a backtick run -> its length
  tickClose: Map<number, number> // start of a run -> start of the next run of the same length
  pair: Map<number, number> // `[` index -> its `]` index
}

function markUp(s: string): Marks {
  const tickLen = new Map<number, number>()
  const tickClose = new Map<number, number>()
  const open = new Map<number, number>() // run length -> start of the last run without a closer yet, scanning backwards
  const runs: Array<[number, number]> = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '`') {
      let j = i
      while (s[j] === '`') j++
      runs.push([i, j - i])
      tickLen.set(i, j - i)
      i = j - 1
    }
  }
  for (let k = runs.length - 1; k >= 0; k--) {
    const [start, len] = runs[k]!
    const next = open.get(len)
    if (next !== undefined) tickClose.set(start, next)
    open.set(len, start)
  }
  const pair = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '`') {
      const len = tickLen.get(i)
      if (len === undefined) continue
      const close = tickClose.get(i)
      i = close === undefined ? i + len - 1 : close + len - 1
    } else if (c === '[') stack.push(i)
    else if (c === ']') {
      const o = stack.pop()
      if (o !== undefined) pair.set(o, i)
    }
  }
  return { tickLen, tickClose, pair }
}

type LinkParse = { end: number; label: string; href: string }

/** Parse `[label](dest "title")` at `from` (the `[`). Follows the renderer's lexer. */
function parseInlineLink(s: string, from: number, marks: Marks): LinkParse | null {
  const close = marks.pair.get(from)
  if (close === undefined || s[close + 1] !== '(') return null
  let i = close + 2
  while (i < s.length && /\s/.test(s[i]!)) i++
  const label = s.slice(from + 1, close)
  let href: string
  let end: number
  if (s[i] === '<') {
    const m = at(ANGLE_DEST, s, i)
    if (!m) return null
    href = m[1]!
    end = i + m[0].length
  } else {
    const run = at(PLAIN_DEST, s, i)![0]
    if (run.length >= MAX_DEST) return null
    const titled = at(TITLED_END, s, i + run.length)
    const plain = titled ? null : at(PLAIN_END, s, i + run.length)
    if (titled) {
      href = run
      end = i + run.length + titled[0].length
    } else if (plain) {
      href = run
      end = i + run.length + plain[0].length
    } else if (run.includes(')')) {
      // The destination ends at the last `)` of the run: `[a](url).` and `([a](url))` are links.
      const k = run.lastIndexOf(')')
      href = run.slice(0, k)
      end = i + k + 1
    } else return null
    const stop = findClosingParen(href)
    if (stop === -2) return null
    if (stop > -1) {
      end -= href.length - stop + 1
      href = href.slice(0, stop)
    }
  }
  href = href.replace(/\\([!-/:-@[-`{-~])/g, '$1')
  return { end, label, href }
}

/** Reference definitions the text holds: `[id]: url`. The renderer ignores them. */
function collectDefinitions(text: string): Map<string, string> {
  const defs = new Map<string, string>()
  for (const m of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?/gm))
    defs.set(m[1]!.toLowerCase().replace(/\s+/g, ' '), m[2]!)
  return defs
}

function scanInline(src: string, opts: ScanOptions): Found[] {
  const found: Found[] = []
  const starts: number[] = [] // start offset of each entry in `found`
  const add = (pos: number, f: Found) => {
    starts.push(pos)
    // A destination with a control character (a raw ESC or BEL in a reply) is drawn as plain text.
    found.push(f.kind === 'link' && CONTROL.test(f.url) ? { ...f, kind: 'non-clickable' } : f)
  }
  const defs = collectDefinitions(src)
  const marks = markUp(src)
  const mask = src.split('') // characters that plain-text rules (issue refs) may still read
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) mask[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') {
      const len = marks.tickLen.get(i) ?? 1
      const close = marks.tickClose.get(i)
      if (close === undefined) {
        i += len
        continue
      }
      blank(i, close + len)
      i = close + len
      continue
    }
    if (c === '<') {
      const auto = at(AUTOLINK, src, i)
      if (auto) {
        const url = auto[1]!
        const isMail = /^mailto:/i.test(url)
        add(i, isMail ? { url, via: 'mailto', kind: 'non-clickable' } : { url, via: 'autolink', kind: 'link' })
        blank(i, i + auto[0].length)
        i += auto[0].length
        continue
      }
      const mail = at(EMAIL_AUTOLINK, src, i)
      if (mail) {
        add(i, { url: 'mailto:' + mail[1]!, via: 'mailto', kind: 'non-clickable' })
        blank(i, i + mail[0].length)
        i += mail[0].length
        continue
      }
      const tag = at(HTML_TAG, src, i)
      if (tag) {
        blank(i, i + tag[0].length)
        i += tag[0].length
        continue
      }
      i++
      continue
    }
    if (c === '!' && src[i + 1] === '[') {
      const p = parseInlineLink(src, i + 1, marks)
      if (p) {
        add(i, { url: p.href, label: p.label || undefined, via: 'image', kind: 'non-clickable' })
        blank(i, p.end)
        i = p.end
        continue
      }
      i++
      continue
    }
    if (c === '[') {
      const p = parseInlineLink(src, i, marks)
      if (p) {
        const label = p.label.trim() === '' ? undefined : p.label
        if (/^mailto:/i.test(p.href)) add(i, { url: p.href, label, via: 'mailto', kind: 'non-clickable' })
        else {
          const url = emittedUrl(p.href)
          if (url === null) add(i, { url: p.href, label, via: 'inline', kind: 'non-clickable' })
          else add(i, { url, label: label === url ? undefined : label, via: 'inline', kind: 'link' })
        }
        blank(i, p.end)
        i = p.end
        continue
      }
      // `[text][id]`, `[text][]`, `[id]`: the renderer drops definitions, so these stay text.
      const close = marks.pair.get(i)
      if (close !== undefined && defs.size > 0 && src[close + 1] !== ':') {
        const label = src.slice(i + 1, close)
        const second = src[close + 1] === '[' ? marks.pair.get(close + 1) : undefined
        const id = (second === undefined ? label : second === close + 2 ? label : src.slice(close + 2, second))
          .toLowerCase()
          .replace(/\s+/g, ' ')
        const target = defs.get(id)
        if (target !== undefined) {
          const end = (second ?? close) + 1
          add(i, { url: target, label, via: 'reference', kind: 'non-clickable' })
          blank(i, end)
          i = end
          continue
        }
      }
      i++
      continue
    }
    if (c === 'h' || c === 'f' || c === 'w') {
      const m = at(BARE, src, i)
      if (m) {
        const raw = trimBare(m[0])
        if (raw !== '') {
          const isWww = raw.startsWith('www.')
          add(i, { url: isWww ? 'http://' + raw : raw, label: isWww ? raw : undefined, via: 'bare', kind: 'link' })
          blank(i, i + raw.length)
          i += raw.length
          continue
        }
      }
    }
    i++
  }
  // Plain text only: `owner/repo#12`.
  const host = opts.issueHost
  if (host !== undefined && !NO_ISSUE_HOSTS.includes(host)) {
    const plain = mask.join('')
    const sep = host === 'gitlab.com' ? '/-/issues/' : '/issues/'
    for (const m of plain.matchAll(ISSUE_REF)) {
      add(m.index! + m[1]!.length, {
        url: `https://${host}/${m[2]}${sep}${m[3]}`,
        label: `${m[2]}#${m[3]}`,
        via: 'issue-ref',
        kind: 'link',
      })
    }
  }
  return found
    .map((f, k) => ({ f, k }))
    .sort((x, y) => starts[x.k]! - starts[y.k]!)
    .map(x => x.f)
}

/** Links the engine's renderer makes out of Markdown text, in order of appearance. */
export function scanMarkdown(text: string, opts: ScanOptions = {}): Found[] {
  if (text === '') return []
  return scanInline(stripCodeBlocks(capText(text)), opts)
}

// ---------------------------------------------------------------- OSC 8

// OSC 8 ; params ; URI ST. ST is BEL or ESC \.
const OSC8 = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// Everything else that draws nothing: CSI, other OSC/DCS/APC/PM/SOS strings, charset selects.
const OTHER_ESC = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_X^][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g

export type Osc8Found = Found & { id?: string }

function paramId(params: string): string | undefined {
  for (const p of params.split(':')) if (p.startsWith('id=')) return p.slice(3)
}

/**
 * Hyperlinks in raw terminal text. A non-empty URI opens a span. An empty URI closes it. A new open
 * ends the span before it. Spans with the same `id` and URI are one link, as a terminal treats them.
 */
export function scanOsc8(text: string): Osc8Found[] {
  if (!text.includes('\x1b]8;')) return []
  type Open = { url: string; id?: string; label: string }
  const spans: Open[] = []
  let cur: Open | null = null
  let pos = 0
  const visible = (s: string) => s.replace(OSC8, '').replace(OTHER_ESC, '')
  for (const m of text.matchAll(OSC8)) {
    if (cur) cur.label += visible(text.slice(pos, m.index))
    pos = m.index! + m[0].length
    if (cur) {
      spans.push(cur)
      cur = null
    }
    const uri = m[2]!
    if (uri !== '') cur = { url: uri, id: paramId(m[1]!), label: '' }
  }
  if (cur) {
    ;(cur as Open).label += visible(text.slice(pos))
    spans.push(cur)
  }
  const out: Osc8Found[] = []
  for (const s of spans) {
    const label = s.label.replace(/[\x00-\x1f\x7f]/g, '').trim()
    const same = s.id === undefined ? undefined : out.find(o => o.id === s.id && o.url === s.url)
    if (same) {
      if (label !== '') same.label = (same.label ?? '') + label
      continue
    }
    out.push({
      url: s.url,
      label: label === '' || label === s.url ? undefined : label,
      via: 'osc8',
      kind: 'link',
      id: s.id,
    })
  }
  return out
}

// ---------------------------------------------------------------- content blocks

/** The text of a message's content: a string, or blocks (`text`, and a tool_result's string or block content). */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as Array<Record<string, unknown>>) {
    if (b === null || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'tool_result') parts.push(textOfContent(b.content))
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------- merge

export type Source = { door: string; uuid: string; agentId?: string }

/**
 * Add `found` to `list`. A URL already there only counts up. The list keeps the newest `cap`
 * entries. Returns the new list and how many entries fell off the front.
 */
export function mergeLinks(
  list: readonly Captured[],
  found: readonly Found[],
  src: Source,
  cap: number,
): { list: Captured[]; dropped: number } {
  const next = list.map(c => ({ ...c }))
  const index = new Map(next.map((c, k) => [c.url + '\u0000' + c.kind, k]))
  for (const f of found) {
    const url = normalizeUrl(f.url)
    const key = url + '\u0000' + f.kind
    const at = index.get(key)
    if (at !== undefined) {
      next[at]!.n++
      continue
    }
    index.set(key, next.length)
    const entry: Captured = { url, via: f.via, kind: f.kind, web: isWebUrl(url), door: src.door, uuid: src.uuid, n: 1 }
    if (f.label !== undefined) entry.label = f.label
    if (src.agentId !== undefined) entry.agentId = src.agentId
    next.push(entry)
  }
  const dropped = Math.max(0, next.length - cap)
  return { list: dropped > 0 ? next.slice(dropped) : next, dropped }
}

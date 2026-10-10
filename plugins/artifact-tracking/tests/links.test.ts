// Copied from docs/knowledge-base/claude-code-link-capture/example/link-capture/tests/links.test.ts (2026-10-10).
// Scanner tests. Pure code, so no `$` is used. The expected values marked "observed" were read
// from the OSC 8 bytes of a real Claude Code 2.1.295 terminal session (FORCE_HYPERLINK=1) that
// drew the same Markdown. See the KB page, section 3.
import { expect, test } from 'claude-code/testing'
import { emittedUrl, mergeLinks, normalizeUrl, scanMarkdown, scanOsc8, textOfContent, MAX_TEXT } from '../hooks/scan/links'
import type { Found } from '../hooks/scan/links'

const links = (text: string, opts = {}) => scanMarkdown(text, opts).filter((f) => f.kind === 'link').map((f) => f.url)
const plain = (text: string) => scanMarkdown(text).filter((f) => f.kind === 'non-clickable').map((f) => f.via + ':' + f.url)

// ---------------------------------------------------------------- Markdown

test('inline link: label, title, nested parens and brackets (observed)', () => {
  expect(scanMarkdown('[lbl](https://example.com/inline "ttl")')).toEqual([{ url: 'https://example.com/inline', label: 'lbl', via: 'inline', kind: 'link' }])
  expect(links('[t](https://e.com/title2 \'T\') [t](https://e.com/title3 (T))')).toEqual(['https://e.com/title2', 'https://e.com/title3'])
  expect(links('[a [b]](https://e.com/p_(q)) end')).toEqual(['https://e.com/p_(q)'])
  expect(links('[a](https://e.com/(a)(b)) and [u](https://e.com/a(b) x')).toEqual(['https://e.com/(a)(b)', 'https://e.com/a(b'])
  expect(links('[a](<https://e.com/sp ace>) end')).toEqual(['https://e.com/sp ace'])
  expect(links('[https://a.com/lbl](https://b.com/dest)')).toEqual(['https://b.com/dest'])
  expect(links('[multi\nline](https://e.com/ml1)')).toEqual(['https://e.com/ml1'])
  expect(links('[**bold**](https://e.com/b) [ ](https://e.com/ws)')).toEqual(['https://e.com/b', 'https://e.com/ws'])
})

test('inline link: punctuation after the closing paren is outside the link (found in a live run)', () => {
  expect(links('Bye [two](https://two.example/y). And ([a](https://e.com/p)), then [b](https://e.com/q)! [c](https://e.com/r)')).toEqual([
    'https://two.example/y', 'https://e.com/p', 'https://e.com/q', 'https://e.com/r',
  ])
  expect(scanMarkdown('[a](https://e.com/(x)).')).toEqual([{ url: 'https://e.com/(x)', label: 'a', via: 'inline', kind: 'link' }])
})

test('inline link: a destination with a space and no angle brackets is no link; its URL part is a bare link (observed)', () => {
  expect(scanMarkdown('[n5](https://e.com/a b/c)').map((f) => f.via + ':' + f.url)).toEqual(['bare:https://e.com/a'])
})

test('inline link: schemes are not filtered (observed: ftp, ssh, tel, data, javascript are all drawn as links)', () => {
  expect(links('[a](ftp://h/x) [b](ssh://git@h/x) [c](tel:+123) [d](data:text/html,hi) [e](javascript:alert(1))')).toEqual([
    'ftp://h/x', 'ssh://git@h/x', 'tel:+123', 'data:text/html,hi', 'javascript:alert(1)',
  ])
})

test('destinations: absolute paths become file URLs, `//host` is plain text, relative stays (observed)', () => {
  expect(links('[a](/etc/hosts) [b](/tmp/../etc/x) [c](/) [d](/Users/x/a.md:12) [e](/tmp/a%20b.md)')).toEqual([
    'file:///etc/hosts', 'file:///etc/x', 'file:///', 'file:///Users/x/a.md:12', 'file:///tmp/a%20b.md',
  ])
  expect(links('[a](docs/readme.md) [b](./rel) [c](#frag) [d](?q=1) [e](~/foo)')).toEqual(['docs/readme.md', './rel', '#frag', '?q=1', '~/foo'])
  expect(plain('[s2](//e.com/proto)')).toEqual(['inline://e.com/proto'])
  expect(links('[p2](/tmp/a b.md)')).toEqual([]) // a space ends the destination: no link
  expect(emittedUrl('/a/./b/../c')).toBe('file:///a/c')
  expect(emittedUrl('//host/x')).toBeNull()
})

test('destination escapes are removed; entities are not decoded (observed)', () => {
  expect(links('[u7](https://e.com/\\))')).toEqual(['https://e.com/)'])
  expect(links('[u1](https://e.com/p?a=1&amp;b=2)')).toEqual(['https://e.com/p?a=1&amp;b=2'])
})

test('autolinks: any scheme is a link; mailto and e-mail are plain text (observed)', () => {
  expect(links('<https://e.com/al5> <ftp://e.com/al1> <foo:bar>')).toEqual(['https://e.com/al5', 'ftp://e.com/al1', 'foo:bar'])
  expect(scanMarkdown('<mailto:a@b.com> <a@b.com> [m](mailto:a@b.com)').map((f) => f.via + ' ' + f.kind)).toEqual(['mailto non-clickable', 'mailto non-clickable', 'mailto non-clickable'])
})

test('bare URLs: trailing punctuation is trimmed as GFM does (observed)', () => {
  expect(links('see https://e.com/t1. And (https://e.com/t2) and https://e.com/t3, then https://e.com/t4! also https://e.com/t5?x=1&y=2; ok https://e.com/t6) x')).toEqual([
    'https://e.com/t1', 'https://e.com/t2', 'https://e.com/t3', 'https://e.com/t4', 'https://e.com/t5?x=1&y=2', 'https://e.com/t6',
  ])
})

test('bare URLs: emphasis marks around a URL stay outside it (observed)', () => {
  expect(links('**https://e.com/em1** *https://e.com/em2* _https://e.com/em3_ ~~https://e.com/em4~~ https://e.com/a_b_c_')).toEqual([
    'https://e.com/em1', 'https://e.com/em2', 'https://e.com/em3', 'https://e.com/em4', 'https://e.com/a_b_c',
  ])
})

test('bare URLs: scheme must be lower case; www. gets http://; no scheme or e-mail is not a link (observed)', () => {
  expect(links('http://localhost:3000/x HTTPS://E.COM/UP ftp://e.com/ftp e.com/noscheme www.e.com a@b.com git@github.com:o/r.git')).toEqual([
    'http://localhost:3000/x', 'ftp://e.com/ftp', 'http://www.e.com',
  ])
  expect(scanMarkdown('www.e.com')[0]).toEqual({ url: 'http://www.e.com', label: 'www.e.com', via: 'bare', kind: 'link' })
  expect(links('https://e.com/ü')).toEqual(['https://e.com/ü'])
})

test('bare URL in a Markdown backslash escape: the escape does not protect it (observed)', () => {
  expect(links('\\[x](https://e.com/esc1) and [x\\](https://e.com/esc2) and \\<https://e.com/esc3>')).toEqual([
    'https://e.com/esc1', 'https://e.com/esc2', 'https://e.com/esc3>',
  ])
})

test('reference-style links: the renderer drops definitions, so they stay text; the definition URL is a bare link (observed)', () => {
  const text = '[reflbl][r1] and [r1] and [reflbl][]\n[r1]: https://example.com/ref'
  expect(plain(text)).toEqual(['reference:https://example.com/ref', 'reference:https://example.com/ref']) // [reflbl][r1] and [r1]; [reflbl][] names no definition
  expect(links(text)).toEqual(['https://example.com/ref'])
  expect(links('[text][nope]')).toEqual([])
})

test('code: spans, double-backtick spans, fenced and indented blocks hold no links (observed)', () => {
  expect(links('`https://e.com/c` and ``x `https://e.com/cs2` y`` and [`code`](https://e.com/cs1)')).toEqual(['https://e.com/cs1'])
  expect(links('```\nhttps://e.com/f\n[x](https://e.com/fi)\n```\nafter https://e.com/after')).toEqual(['https://e.com/after'])
  expect(links('~~~sh\nhttps://e.com/tilde\n~~~\n')).toEqual([])
  expect(links('text\n\n    https://e.com/indent\n    [x](https://e.com/indentinline)\n\nend https://e.com/end')).toEqual(['https://e.com/end'])
  expect(links('```\nunclosed https://e.com/never')).toEqual([])
  expect(links('a ` b https://e.com/openTick')).toEqual(['https://e.com/openTick']) // a lone backtick opens nothing
})

test('code: an indented line inside a list item is not code', () => {
  expect(links('- item\n\n    continued https://e.com/inlist')).toEqual(['https://e.com/inlist'])
})

test('code: a list item reads 4 columns past its marker as code; HTML blocks end at a blank line (observed)', () => {
  expect(links('1. num\n\n       deeper https://e.com/deep\n\n- item\n\n    continued https://e.com/inlist')).toEqual(['https://e.com/inlist'])
  expect(links('<div>\nsee https://e.com/htmlblock and [x](https://e.com/htmllink)\n</div>\n\nafter https://e.com/afterhtml')).toEqual(['https://e.com/afterhtml'])
  expect(links('<!-- https://e.com/comment -->\nnext https://e.com/next')).toEqual(['https://e.com/next'])
})

test('escapes, entities and emphasis marks inside URLs (observed)', () => {
  expect(links('[a](https://e.com/b\\_c) &amp; https://e.com/x&amp;y https://e.com/a*b*c https://e.com/under_score_x foo_https://e.com/mid')).toEqual([
    'https://e.com/b_c', 'https://e.com/x&amp;y', 'https://e.com/a*b*c', 'https://e.com/under_score_x', 'https://e.com/mid',
  ])
  expect(links('- [ ] todo [x](https://e.com/task)\n\nTitle\n=====\nhttps://e.com/setext')).toEqual(['https://e.com/task', 'https://e.com/setext'])
})

test('control characters: a URL with a raw ESC or BEL in it is plain text (observed; raw OSC 8 in a reply is not a link)', () => {
  const raw = 'RAW \x1b]8;;https://raw.example/x\x07raw label\x1b]8;;\x07 mid \x1b]8;;https://raw.example/st\x1b\\st\x1b]8;;\x1b\\ end https://md.example/ok'
  expect(links(raw)).toEqual(['https://md.example/ok'])
  expect(scanMarkdown(raw).filter((f) => f.kind === 'non-clickable').length).toBe(2)
})

test('images are not links; an image inside a link keeps the outer link (observed)', () => {
  expect(plain('![alt](https://e.com/img.png) ![](https://e.com/img2.png)')).toEqual(['image:https://e.com/img.png', 'image:https://e.com/img2.png'])
  expect(links('[![img](https://e.com/i.png)](https://e.com/imglink)')).toEqual(['https://e.com/imglink'])
})

test('inline HTML is text: a URL in an attribute is not captured (observed)', () => {
  expect(links('<a href="https://e.com/html1">h</a> and <https://e.com/al6 trailing>')).toEqual(['https://e.com/al6'])
})

test('tables, lists, quotes and headings are scanned (observed)', () => {
  const text = '| a | b |\n|---|---|\n| [x](https://e.com/tbl1) | https://e.com/tbl2 |\n\n- item https://e.com/li1\n  - [n](https://e.com/li2)\n\n> quote [q](https://e.com/bq) https://e.com/bq2\n\n# Heading [h](https://e.com/hd) https://e.com/hd2'
  expect(links(text)).toEqual(['https://e.com/tbl1', 'https://e.com/tbl2', 'https://e.com/li1', 'https://e.com/li2', 'https://e.com/bq', 'https://e.com/bq2', 'https://e.com/hd', 'https://e.com/hd2'])
})

test('issue references: owner/repo#12 becomes a host link in plain text only (observed)', () => {
  expect(scanMarkdown('fix acme/widgets#42 now')).toEqual([
    { url: 'https://github.com/acme/widgets/issues/42', label: 'acme/widgets#42', via: 'issue-ref', kind: 'link' },
  ])
  expect(links('see acme/widgets#42', { issueHost: 'gitlab.com' })).toEqual(['https://gitlab.com/acme/widgets/-/issues/42'])
  expect(links('see acme/widgets#42', { issueHost: 'bitbucket.org' })).toEqual([])
  expect(links('`acme/widgets#42` and [acme/widgets#42](https://e.com/x) and x/acme/widgets#42')).toEqual(['https://e.com/x'])
})

test('issue references: any word/word#n matches, a path with an extension too (observed quirk)', () => {
  expect(links('src/a.ts#12 and docs/readme.md#3, Org/Repo.js#9 (acme/widgets#8) and x/acme/widgets#10')).toEqual([
    'https://github.com/src/a.ts/issues/12', 'https://github.com/docs/readme.md/issues/3', 'https://github.com/Org/Repo.js/issues/9', 'https://github.com/acme/widgets/issues/8',
  ])
})

test('order follows the text, issue references included (observed)', () => {
  expect(links('acme/w#1 then www.a.org and [l](https://b.org)')).toEqual(['https://github.com/acme/w/issues/1', 'http://www.a.org', 'https://b.org'])
})

test('input cap and hostile text stay fast', () => {
  for (const text of ['['.repeat(MAX_TEXT), '[a]('.repeat(MAX_TEXT / 4), '<a'.repeat(MAX_TEXT / 2), '`'.repeat(MAX_TEXT), 'https://x.org/' + '('.repeat(MAX_TEXT)]) {
    scanMarkdown(text)
  }
  expect(scanMarkdown('x'.repeat(MAX_TEXT) + ' https://e.com/cut')).toEqual([])
})

// ---------------------------------------------------------------- OSC 8

const ESC = '\x1b'
const BEL = '\x07'
const ST = ESC + '\\'

test('OSC 8: BEL and ST terminators, id params, plain and styled text around (observed on a Bash tool result)', () => {
  const raw = `${ESC}]8;id=k1;https://tool.example/bel${BEL}bel label${ESC}]8;;${BEL} and ${ESC}]8;;https://tool.example/st${ST}st label${ESC}]8;;${ST} ${ESC}[1mbold${ESC}[0m plain https://plain.example/p`
  expect(scanOsc8(raw)).toEqual([
    { url: 'https://tool.example/bel', label: 'bel label', via: 'osc8', kind: 'link', id: 'k1' },
    { url: 'https://tool.example/st', label: 'st label', via: 'osc8', kind: 'link', id: undefined },
  ])
})

test('OSC 8: CSI styling inside a span is not part of the label', () => {
  const raw = `${ESC}]8;;https://a.org${BEL}${ESC}[94mblue${ESC}[39m${ESC}]8;;${BEL}`
  expect(scanOsc8(raw)[0]?.label).toBe('blue')
})

test('OSC 8: a new open ends the span before it, with no close between (observed in the renderer output)', () => {
  const raw = `${ESC}]8;id=a;https://one.org${BEL}n1${ESC}]8;id=b;https://two.org${BEL}n2${ESC}]8;;${BEL}`
  expect(scanOsc8(raw).map((f) => f.url + '|' + f.label)).toEqual(['https://one.org|n1', 'https://two.org|n2'])
})

test('OSC 8: spans with the same id and URI are one link (a wrapped line)', () => {
  const raw = `${ESC}]8;id=w;https://wrap.org${BEL}first${ESC}]8;;${BEL}\r\n${ESC}]8;id=w;https://wrap.org${BEL}second${ESC}]8;;${BEL}`
  expect(scanOsc8(raw)).toEqual([{ url: 'https://wrap.org', label: 'firstsecond', via: 'osc8', kind: 'link', id: 'w' }])
})

test('OSC 8: no id means separate links; an empty label stays absent; an open span ends at the end of the text', () => {
  const raw = `${ESC}]8;;https://x.org${BEL}${ESC}]8;;${BEL}${ESC}]8;;https://x.org${BEL}tail`
  expect(scanOsc8(raw).map((f) => f.url + '|' + f.label)).toEqual(['https://x.org|undefined', 'https://x.org|tail'])
})

test('OSC 8: text without OSC 8, and other OSC strings, give nothing', () => {
  expect(scanOsc8('plain https://x.org')).toEqual([])
  expect(scanOsc8(`${ESC}]0;title${BEL}${ESC}]52;c;AAAA${BEL}`)).toEqual([])
})

// ---------------------------------------------------------------- content shapes and merge

test('textOfContent: a string, text blocks, and a tool_result with string or block content', () => {
  expect(textOfContent('abc')).toBe('abc')
  expect(textOfContent([{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  expect(textOfContent([{ type: 'tool_result', tool_use_id: 't', content: 'out' }])).toBe('out')
  expect(textOfContent([{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'blk' }] }])).toBe('blk')
  expect(textOfContent(undefined)).toBe('')
})

test('mergeLinks: a repeat only counts up; kinds and web flags are kept apart; the list is capped', () => {
  const src = { door: 'response', uuid: 'u1' }
  const a: Found[] = [{ url: 'https://x.org', via: 'bare', kind: 'link' }, { url: 'mailto:a@b.c', via: 'mailto', kind: 'non-clickable' }]
  const first = mergeLinks([], a, src, 10)
  expect(first.list.map((c) => [c.url, c.web, c.n])).toEqual([['https://x.org/', true, 1], ['mailto:a@b.c', false, 1]])
  const second = mergeLinks(first.list, [{ url: 'https://x.org/', via: 'inline', kind: 'link' }], { door: 'response', uuid: 'u2', agentId: 'ag' }, 10)
  expect(second.list.length).toBe(2)
  expect(second.list[0]).toMatchObject({ n: 2, uuid: 'u1', via: 'bare' })
  const capped = mergeLinks(second.list, [{ url: 'https://y.org', via: 'bare', kind: 'link' }, { url: 'https://z.org', via: 'bare', kind: 'link' }], src, 2)
  expect(capped.dropped).toBe(2)
  expect(capped.list.map((c) => c.url)).toEqual(['https://y.org/', 'https://z.org/'])
  expect(normalizeUrl(' https://x.org ')).toBe('https://x.org/')
  expect(normalizeUrl('tel:+1')).toBe('tel:+1')
})

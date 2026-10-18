// The capture scan: one text, the URLs offered to the kinds by rank, the claimed spans masked, each kind scanning the
// rest. Pure: the shipped kinds over a fake context. Plan: L5 Task 5, K21, K22, K23, Review Focus 1 and 3.
import { expect, test } from 'claude-code/testing'
import { scanClaims } from '../core/infra/capture'
import type { ItemKind } from '../core/interfaces/items'
import { parseRemote } from '../core/lib/git'
import { type ScanContextOptions, scanContext } from '../core/lib/kind-context'
import { scanMarkdown } from '../core/lib/links'
import { artifactKind } from '../trackers/artifact/kind'
import { FILE_DEFAULTS } from '../trackers/file/config'
import { fileKind } from '../trackers/file/kind'
import { GITHUB_DEFAULTS } from '../trackers/github/config'
import { githubKind } from '../trackers/github/kind'
import { HOST_ALIASES } from '../trackers/github/remote'
import { parseGitHubUrl } from '../trackers/github/urls'
import { jiraKind } from '../trackers/jira/kind'
import { JIRA_KEY, parseJiraUrl } from '../trackers/jira/urls'
import { webKind } from '../trackers/web/kind'
import { PAGE_KEY, PAGE_URL } from './fixtures/artifacts'

const KINDS: readonly ItemKind[] = [webKind, fileKind, artifactKind, jiraKind, githubKind] // the order is not the rank
const REPO = { host: 'github.com', owner: 'acme', repo: 'web' }

const context = (o: Partial<ScanContextOptions> = {}) =>
  scanContext({
    mode: 'full',
    purpose: 'capture',
    facts: { 'session.repo': REPO, 'github.hosts': [] },
    slice: { ...GITHUB_DEFAULTS, ...FILE_DEFAULTS },
    ...o,
  })
const claims = (text: string, o: Partial<ScanContextOptions> = {}, mode: 'full' | 'urls-only' = 'full') =>
  scanClaims(text, mode, KINDS, context(o))
const keys = (text: string, o: Partial<ScanContextOptions> = {}, mode: 'full' | 'urls-only' = 'full') =>
  claims(text, o, mode).map(c => c.key)

test('capture: an issue URL goes to github and never also to web', () => {
  expect(keys('see https://github.com/acme/web/issues/5')).toEqual(['gh:github.com/acme/web#5'])
  expect(keys('see [the issue](https://github.com/acme/web/issues/5#issuecomment-9)')).toEqual([
    'gh:github.com/acme/web#5',
  ])
})

test('capture: an artifact URL goes to artifact, a Jira URL to jira, any other URL to web', () => {
  const text = `a https://x.example/doc and [page](${PAGE_URL}) and https://acme.atlassian.net/browse/ISS-3.`
  const found = claims(text)
  expect(found.map(c => c.category)).toEqual(['web', 'artifact', 'jira'])
  expect(found.map(c => c.key)).toEqual(['web:https://x.example/doc', PAGE_KEY, 'jira:acme.atlassian.net/ISS-3'])
  expect(found[1]?.fields).toEqual({ uuid: expect.any(String), url: PAGE_URL, label: 'page' })
  expect(found[0]?.fields).toEqual({ url: 'https://x.example/doc', label: 'x.example/doc' })
})

test('capture: a GHE URL is github only when github.hosts lists the host', () => {
  const text = 'https://ghe.corp/acme/web/pull/7'
  const off = claims(text)
  expect(off.map(c => [c.category, c.key])).toEqual([['web', 'web:https://ghe.corp/acme/web/pull/7']])
  const on = claims(text, { facts: { 'session.repo': REPO, 'github.hosts': ['ghe.corp'] } })
  expect(on.map(c => [c.category, c.key])).toEqual([['github', 'gh:ghe.corp/acme/web#7']])
  expect(on[0]?.fields).toMatchObject({ host: 'ghe.corp', number: 7, type: 'pr' })
})

test('capture: a bare issue #5 with no session repo tracks nothing; a lookup gives gh:?#5', () => {
  const none = { facts: { 'session.repo': null, 'github.hosts': [] } }
  expect(keys('see issue #5', { ...none, purpose: 'capture' })).toEqual([])
  expect(keys('see issue #5', { ...none, purpose: 'lookup' })).toEqual(['gh:?#5'])
  expect(keys('and #5 alone', { ...none, purpose: 'lookup' })).toEqual(['gh:?#5'])
  expect(keys('and #5 alone', { facts: {}, purpose: 'lookup' })).toEqual(['gh:?#5'])
})

test('capture: claimed spans are masked before the kind scans', () => {
  // Today's `extractRefs` gave #9 and #5 here: the label of a claimed link was read as plain text. The scan masks the link.
  expect(keys('[issue #9](https://github.com/acme/web/issues/5)')).toEqual(['gh:github.com/acme/web#5'])
  expect(keys('[acme/web#7](https://x.example/a) and issue #6')).toEqual([
    'web:https://x.example/a',
    'gh:github.com/acme/web#6',
  ])
  // A title after the URL, or a label the scanner changed, stays visible: only the URL is masked then.
  expect(keys('[x](https://x.example/a "issue #9")')).toEqual(['web:https://x.example/a', 'gh:github.com/acme/web#9'])
})

test('capture: the label of any claimed Markdown link hides from the kind scans, a web link included', () => {
  // A deliberate change of layer L5a (spec 5.9, capture step 3): the web kind claims every http(s) link in full mode, so
  // a keyworded #N or a .md name in a link label is no longer read as plain text. `extractRefs` read it.
  expect(keys('[fixes issue #9](https://ci.example/run/1)')).toEqual(['web:https://ci.example/run/1'])
  expect(keys('see [plan.md](https://example.com/x)')).toEqual(['web:https://example.com/x'])
  // The same words outside a link still track.
  expect(keys('fixes issue #9 on https://ci.example/run/1')).toEqual([
    'gh:github.com/acme/web#9',
    'web:https://ci.example/run/1',
  ])
  expect(keys('see plan.md and https://example.com/x')).toEqual(['web:https://example.com/x', 'file:plan.md']) // a claim with no span goes last
})

test('capture: urls-only keeps explicit github and jira URLs only', () => {
  const text = [
    'https://x.example/doc',
    PAGE_URL,
    'issue #5',
    'acme/web#8',
    'docs/a.md',
    '(https://github.com/acme/web/pull/6).',
    'https://acme.atlassian.net/browse/ISS-3,',
  ].join(' ')
  const found = claims(text, {}, 'urls-only')
  expect(found.map(c => c.key)).toEqual(['gh:github.com/acme/web#6', 'jira:acme.atlassian.net/ISS-3'])
  expect(found.map(c => c.span?.start)).toEqual([
    text.indexOf('https://github.com/acme'),
    text.indexOf('https://acme.atl'),
  ])
  // A long run of punctuation glued to a URL stays fast: the trailing cut is linear.
  const t0 = Date.now()
  expect(keys(`https://github.com/a/b/issues/1${'.'.repeat(100_000)}x`, {}, 'urls-only')).toEqual([])
  expect(Date.now() - t0).toBeLessThan(500)
})

test('capture: one key twice is one claim at its first place', () => {
  const text = 'issue #5 then https://github.com/acme/web/issues/5 and https://github.com/acme/web/issues/5/files'
  const found = claims(text)
  expect(found).toHaveLength(1)
  expect(found[0]?.span?.start).toBe(text.indexOf('#5'))
  // The same page twice, once by UUID form: one artifact claim.
  expect(keys(`${PAGE_URL} ${PAGE_URL}/`)).toEqual([PAGE_KEY])
})

test('capture: claims come in the order of the text, URLs and kind syntax together, with source and time', () => {
  const text = 'https://x.example/a and issue #5 and https://acme.atlassian.net/browse/ISS-3'
  const found = claims(text, { source: 'response', now: 42 })
  expect(found.map(c => c.key)).toEqual([
    'web:https://x.example/a',
    'gh:github.com/acme/web#5',
    'jira:acme.atlassian.net/ISS-3',
  ])
  expect(found.map(c => [c.source, c.at])).toEqual([
    ['response', 42],
    ['response', 42],
    ['response', 42],
  ])
  expect(text.slice(found[1]!.span!.start, found[1]!.span!.end)).toBe('#5')
})

test('capture: a short ref needs a lead word and the session repo; a lookup takes every ref', () => {
  const text = 'issue #5, bug #6 and #7 and acme/web#8 and other/repo#9 and issue other/repo#10'
  expect(keys(text)).toEqual(['gh:github.com/acme/web#5', 'gh:github.com/acme/web#6'])
  expect(claims(text)[0]?.fields).toMatchObject({ short: true, type: 'unknown', number: 5 })
  expect(keys(text, { purpose: 'lookup' })).toEqual([
    'gh:github.com/acme/web#5',
    'gh:github.com/acme/web#6',
    'gh:github.com/acme/web#7',
    'gh:github.com/acme/web#8',
    'gh:github.com/other/repo#9',
    'gh:github.com/other/repo#10',
  ])
  expect(claims(text, { purpose: 'lookup' })[0]?.fields).not.toHaveProperty('short')
  // An issue in another repo needs the lead word and the session repo, so a lead word alone is not enough.
  expect(keys('issue other/repo#10')).toEqual([])
  // The lead words come from the config slice; an empty list tracks no short ref.
  expect(keys('todo #5 and issue #6', { slice: { shortRefKeywords: ['todo'] } })).toEqual(['gh:github.com/acme/web#5'])
  expect(keys('issue #6', { slice: { shortRefKeywords: [] } })).toEqual([])
  expect(keys('issue #6', { slice: {} })).toEqual(['gh:github.com/acme/web#6']) // no slice: the default words
})

test('capture: a file name with an extension is no repo, and a mention in code is not read', () => {
  expect(keys('see src/a.ts#20 and docs/readme.md#3', { purpose: 'lookup' }).filter(k => k.startsWith('gh:'))).toEqual(
    [],
  )
  expect(keys('`issue #5` and\n```\nissue #6\n```\nand issue #7')).toEqual(['gh:github.com/acme/web#7'])
})

test('capture: a web URL over 2048 characters is no claim; a short one next to it is', () => {
  const long = `https://e.example/${'a'.repeat(3000)}`
  expect(keys(`see ${long} and https://short.example/x`)).toEqual(['web:https://short.example/x'])
})

test('capture: .md names are file claims, as spelled; none in urls-only or with the limit at 0', () => {
  const found = claims('see docs/a.md and `b.md` and https://x.example/c.md and [r.md](https://x.example/r)')
  expect(found.map(c => c.key)).toEqual([
    'web:https://x.example/c.md',
    'web:https://x.example/r',
    'file:docs/a.md',
    'file:b.md',
  ])
  expect(found[2]).toMatchObject({
    category: 'file',
    key: 'file:docs/a.md',
    fields: { path: 'docs/a.md', label: 'docs/a.md', activity: 'mentioned', bySubagent: false },
  })
  expect(found[2]?.span).toBeUndefined()
  expect(keys('see docs/a.md', { slice: { maxMentionsPerRow: 0 } })).toEqual([])
  expect(keys('see docs/a.md', {}, 'urls-only')).toEqual([])
  expect(keys('see a.md and b.md', { slice: { maxMentionsPerRow: 1 } })).toEqual(['file:a.md'])
  expect(keys('see a.md', { slice: {} })).toEqual(['file:a.md']) // no slice: the default limit
})

test('capture: the context is asked for each kind, so each kind reads its own config', () => {
  const byKind = (kind: ItemKind) =>
    context({ slice: kind.category === 'github' ? { shortRefKeywords: ['todo'] } : { maxMentionsPerRow: 1 } })
  const text = 'todo #5 and issue #6, see a.md and b.md'
  const found = scanClaims(text, 'full', KINDS, byKind)
  expect(found.map(c => c.key)).toEqual(['gh:github.com/acme/web#5', 'file:a.md'])
})

test("capture: the mode is the caller's, whatever the context says", () => {
  const ctx = context({ mode: 'urls-only' })
  expect(scanClaims('see https://x.example/a', 'full', KINDS, ctx).map(c => c.key)).toEqual(['web:https://x.example/a'])
  expect(scanClaims('see https://x.example/a', 'urls-only', KINDS, context()).map(c => c.key)).toEqual([])
})

test('capture: kinds claim in rank order, the first claim wins, and a kind without a hook is skipped', () => {
  const calls: string[] = []
  const probe = (category: string, rank: number, win: boolean): ItemKind => ({
    category,
    rank,
    decode: () => null,
    merge: () => null,
    claimUrl: (url, _label, ctx) => {
      calls.push(category)
      return win ? { category, key: `${category}:${url}`, source: ctx.source, at: ctx.now, fields: {} } : null
    },
  })
  const plain: ItemKind = { category: 'plain', rank: 0, decode: () => null, merge: () => null }
  const found = scanClaims(
    'https://x.example/a',
    'full',
    [probe('c', 30, true), probe('a', 10, false), probe('b', 20, true), plain],
    context(),
  )
  expect(calls).toEqual(['a', 'b'])
  expect(found.map(c => c.category)).toEqual(['b'])
  expect(scanClaims('', 'full', [plain], context())).toEqual([])
})

test('capture: a hostile text of 40 000 links stays fast', () => {
  const text = 'https://x.example/a [l](https://y.example/b) '.repeat(20_000)
  const t0 = Date.now()
  const found = scanClaims(text, 'full', KINDS, context())
  expect(found.map(c => c.key)).toEqual(['web:https://x.example/a', 'web:https://y.example/b'])
  expect(Date.now() - t0).toBeLessThan(2000)
})

test('parseRemote: an alias table maps the host', () => {
  const remote = 'ssh://git@ssh.github.com:443/acme/web.git'
  expect(parseRemote(remote, HOST_ALIASES)).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(parseRemote(remote)).toEqual({ host: 'ssh.github.com', owner: 'acme', repo: 'web' })
  expect(parseRemote('git@ghe.corp:acme/web.git', HOST_ALIASES)?.host).toBe('ghe.corp')
})

test('parseGitHubUrl and parseJiraUrl read http(s) URLs of their own host only', () => {
  for (const url of ['not a url', 'ftp://github.com/a/b/issues/1', 'mailto:a@b.example', '']) {
    expect(parseGitHubUrl(url)).toBeNull()
    expect(parseJiraUrl(url)).toBeNull()
  }
  expect(parseGitHubUrl('https://github.com/a/b/issues/99999999999999999999')).toBeNull()
  expect(parseGitHubUrl('  https://GitHub.com/a/b/pull/7  ')).toMatchObject({
    host: 'github.com',
    number: 7,
    type: 'pr',
  })
  expect(parseJiraUrl('http://jira.corp/browse/OPS-1')).toMatchObject({ site: 'jira.corp', trackOnly: true })
  expect(JIRA_KEY.test('ISS-1')).toBe(true)
  expect(JIRA_KEY.test('iss-1')).toBe(false)
})

test('scanMarkdown with no issueHost finds no issue reference (K22)', () => {
  expect(scanMarkdown('fix acme/widgets#42 now')).toEqual([])
  expect(scanMarkdown('fix acme/widgets#42 now', { issueHost: 'github.com' })).toHaveLength(1)
})

test('scanContext: the ports a scan does not use are inert', async () => {
  const c = scanContext({ mode: 'full', purpose: 'lookup' })
  expect([c.now, c.source]).toEqual([0, 'prompt'])
  expect(c.config.slice()).toEqual({})
  expect(c.config.global().tools.timeoutMs).toBeGreaterThan(0)
  expect(c.facts.read('anything')).toBeUndefined()
  expect(c.tools.handle('gh')).toBeUndefined()
  await expect(c.tools.run('gh', ['gh'], {})).rejects.toThrow('a scan runs no tool')
  expect(await c.fs.stat('/x')).toBeNull()
  expect(await c.fs.exists('/x')).toBe(false)
  expect([await c.env.get('HOME'), await c.env.settings(), await c.env.agents()]).toEqual([undefined, undefined, []])
  expect([await c.session.id(), await c.session.cwd(), await c.session.repo(), c.session.root()]).toEqual([
    '',
    '',
    null,
    undefined,
  ])
  c.log('nothing')
})

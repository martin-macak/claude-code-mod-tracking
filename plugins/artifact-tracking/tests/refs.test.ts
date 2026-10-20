import { expect } from 'claude-code/testing'
import { MAX_TEXT } from '../core/lib/links'
import { PAGE_CODE_URL, PAGE_ID, PAGE_URL, PAGE_UUID } from './fixtures/artifacts'
import { test } from './fixtures/kit'
import { commandArgs, extractRefs, hostPath, parseGitHubUrl, parseJiraUrl, parseRemote } from './fixtures/refs'
import { expectLinear, SCALE } from './fixtures/scaling'

const repo = { host: 'github.com', owner: 'acme', repo: 'web' }
// The big-input tests check that the cost grows about linearly with the input, not that it stays under a time
// (`expectLinear`, issue #104). The big input is at most `MAX_TEXT`: a scan reads no more, so a bigger one shows nothing.
const full = (t: string, defaultRepo: typeof repo | null = repo) => extractRefs(t, { mode: 'full', defaultRepo })
const fullStrict = (t: string, defaultRepo: typeof repo | null = repo) =>
  extractRefs(t, { mode: 'full', defaultRepo, strictShortRefs: true })

test('GitHub URLs: issue, pull, tails and comment anchors', () => {
  expect(parseGitHubUrl('https://github.com/cli/cli/pull/14640/files#diff-1')).toEqual({
    category: 'github',
    host: 'github.com',
    owner: 'cli',
    repo: 'cli',
    number: 14640,
    type: 'pr',
    url: 'https://github.com/cli/cli/pull/14640',
  })
  expect(parseGitHubUrl('https://github.com/cli/cli/issues/14622#issuecomment-99')?.type).toBe('issue')
  expect(parseGitHubUrl('https://github.com/cli/cli')).toBeNull()
  expect(parseGitHubUrl('https://ghe.corp/a/b/pull/3')).toBeNull()
  expect(parseGitHubUrl('https://ghe.corp/a/b/pull/3', ['ghe.corp'])?.host).toBe('ghe.corp')
})

test('Jira URLs: browse, selectedIssue, issues path, track-only, jql', () => {
  expect(parseJiraUrl('https://acme.atlassian.net/browse/ISS-12')).toEqual({
    category: 'jira',
    site: 'acme.atlassian.net',
    issueKey: 'ISS-12',
    url: 'https://acme.atlassian.net/browse/ISS-12',
    trackOnly: false,
  })
  expect(
    parseJiraUrl('https://acme.atlassian.net/jira/software/projects/ISS/boards/1?selectedIssue=ISS-7')?.issueKey,
  ).toBe('ISS-7')
  expect(parseJiraUrl('https://jira.corp.example/browse/OPS-1')?.trackOnly).toBe(true)
  expect(parseJiraUrl('https://acme.atlassian.net/issues/?jql=project%3DISS')).toBeNull()
  expect(parseJiraUrl('https://acme.atlassian.net/browse/iss-12')).toBeNull()
})

test('full mode: links, labels, issue refs, web links', () => {
  const refs = full(
    'See [the PR](https://github.com/acme/web/pull/5), [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) and cli/cli#14622 and https://acme.atlassian.net/browse/ISS-3.',
  )
  expect(refs).toEqual([
    {
      category: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'web',
      number: 5,
      type: 'pr',
      url: 'https://github.com/acme/web/pull/5',
    },
    { category: 'web', url: 'https://code.claude.com/docs/en/plugins/mods/overview', label: 'Mods overview' },
    {
      category: 'github',
      host: 'github.com',
      owner: 'cli',
      repo: 'cli',
      number: 14622,
      type: 'unknown',
      url: 'https://github.com/cli/cli/issues/14622',
    },
    {
      category: 'jira',
      site: 'acme.atlassian.net',
      issueKey: 'ISS-3',
      url: 'https://acme.atlassian.net/browse/ISS-3',
      trackOnly: false,
    },
  ])
})

test('full mode: an artifact link is an artifact, not a web link, and keeps its Markdown label', () => {
  expect(full(`See [Design notes](${PAGE_URL}).`)).toEqual([
    { category: 'artifact', uuid: PAGE_UUID, url: PAGE_URL, label: 'Design notes' },
  ])
  expect(full(`See ${PAGE_URL}.`)).toEqual([{ category: 'artifact', uuid: PAGE_UUID, url: PAGE_URL, label: PAGE_ID }])
})

test('full mode: both URL forms of one artifact are one ref; a bad id stays a web link', () => {
  expect(full(`${PAGE_URL} and ${PAGE_CODE_URL}`)).toHaveLength(1)
  expect(full('https://claude.ai/artifact/new')).toEqual([
    { category: 'web', url: 'https://claude.ai/artifact/new', label: 'claude.ai/artifact/new' },
  ])
})

test('urls-only mode ignores artifact URLs: tool output is not a mention', () => {
  expect(extractRefs(`Published at ${PAGE_URL}`, { mode: 'urls-only', defaultRepo: null })).toEqual([])
})

test('bare #N: matches prose, skips code, colours, entities, headings, anchors, paths', () => {
  const t = [
    'Fix #12 and (#13), also #14.',
    'Colour #fff and #12ab, entity &#123; and C# 1',
    '# 1 heading',
    '`#15` in code',
    '```\n#16\n```',
    'https://x.example/page#17 and [l](https://y.example/#18) and a/b#19 and src/a.ts#20',
  ].join('\n')
  const nums = full(t)
    .filter(r => r.category === 'github')
    .map(r => (r as { number: number }).number)
  expect(nums).toEqual([12, 13, 14, 19])
})

test('bare #N without a repo stays unresolved; with a repo it resolves', () => {
  expect(full('see #7', null)).toEqual([{ category: 'github', host: 'github.com', number: 7, type: 'unknown' }])
  expect(full('see #7')[0]).toMatchObject({ owner: 'acme', repo: 'web', number: 7 })
})

test('"rank #1" is accepted (documented false positive)', () => {
  expect(full('rank #1').length).toBe(1)
})

test('short refs require a keyword prefix', () => {
  expect(fullStrict('Finding acme/web#5').length).toBe(0)
  expect(fullStrict('step #5').length).toBe(0)
  expect(fullStrict('issue acme/web#5').map(r => (r.category === 'github' ? r.number : 0))).toEqual([5])
  expect(fullStrict('GitHub #5').map(r => (r.category === 'github' ? r.number : 0))).toEqual([5])
  expect(fullStrict('bug #5').map(r => (r.category === 'github' ? r.number : 0))).toEqual([5])
  expect(fullStrict('enhancement #5').map(r => (r.category === 'github' ? r.number : 0))).toEqual([5])
  expect(fullStrict('chore #5').map(r => (r.category === 'github' ? r.number : 0))).toEqual([5])
})

test('keyworded short refs are only accepted for the current repo', () => {
  expect(fullStrict('issue #5')[0]).toMatchObject({ owner: 'acme', repo: 'web', number: 5 })
  expect(fullStrict('issue cli/cli#5').length).toBe(0)
})

test('urls-only mode: only explicit GitHub and Jira URLs, no bare #N, no web links', () => {
  const out =
    'commit abc (#12)\nhttps://github.com/acme/web/pull/9.\nhttps://example.com/x\nhttps://acme.atlassian.net/browse/ISS-4'
  expect(
    extractRefs(out, { mode: 'urls-only', defaultRepo: repo }).map(
      r => r.category + ':' + ('number' in r ? r.number : 'issueKey' in r ? r.issueKey : ''),
    ),
  ).toEqual(['github:9', 'jira:ISS-4'])
})

test('bare Jira keys never create refs in full or urls-only mode', () => {
  const text = 'Fix ISS-101, then ISS-1 and OPS-9.'
  expect(extractRefs(text, { mode: 'full', defaultRepo: repo })).toEqual([])
  expect(extractRefs(text, { mode: 'urls-only', defaultRepo: repo })).toEqual([])
})

test('duplicates collapse, first occurrence wins the position', () => {
  expect(full('#5 https://github.com/ACME/Web/issues/5 #5').length).toBe(1)
})

const BIG_UNIT = 'x https://github.com/a/b/issues/1 #2 ' + 'y'.repeat(100)
const bigInput = (units: number) => BIG_UNIT.repeat(units)

test('huge input is capped, and the cost grows linearly up to the cap', async () => {
  // The cap: a scan reads the first MAX_TEXT characters of 1 MB, so the rest changes nothing.
  const big = bigInput(8000) // ~1 MB
  expect(big.length).toBeGreaterThan(5 * MAX_TEXT)
  expect(extractRefs(big, { mode: 'full', defaultRepo: repo })).toEqual(
    extractRefs(big.slice(0, MAX_TEXT), { mode: 'full', defaultRepo: repo }),
  )
  expect(extractRefs(big, { mode: 'urls-only' })).toEqual(extractRefs(big.slice(0, MAX_TEXT), { mode: 'urls-only' }))
  // The cost: the big input is the cap, the small one a fourth of it.
  const units = MAX_TEXT / SCALE / BIG_UNIT.length
  await expectLinear({
    make: k => bigInput(Math.floor(units * k)),
    run: text => {
      extractRefs(text, { mode: 'full', defaultRepo: repo })
      extractRefs(text, { mode: 'urls-only' })
    },
  })
  // Above the cap the cost is flat: both inputs are cut to MAX_TEXT. A pass over the full text before the cut grows with
  // the input (4 times the text, 16 times the time when that pass is quadratic), which the check above cannot see.
  await expectLinear({
    label: 'above the cap',
    make: k => bigInput(Math.floor((2 * MAX_TEXT * k) / BIG_UNIT.length)), // 400 000 and 1 600 000 characters
    run: text => {
      extractRefs(text, { mode: 'full', defaultRepo: repo })
      extractRefs(text, { mode: 'urls-only' })
    },
  })
})

test('parseRemote: scp, ssh, https with token, .git, garbage', () => {
  expect(parseRemote('git@github.com:acme/web.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(parseRemote('ssh://git@ghe.corp:2222/acme/web')).toEqual({ host: 'ghe.corp', owner: 'acme', repo: 'web' })
  expect(parseRemote('https://user:tok@github.com/acme/web.git')).toEqual({
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
  })
  expect(parseRemote('/local/path')).toBeNull()
})

test('commandArgs and hostPath', () => {
  expect(
    commandArgs(
      '<command-message>foo</command-message>\n<command-name>/foo</command-name>\n<command-args>#12 https://x.example/q</command-args>',
    ),
  ).toBe('#12 https://x.example/q')
  expect(commandArgs('plain')).toBe('')
  expect(hostPath('https://code.claude.com/docs/en/')).toBe('code.claude.com/docs/en')
})

test('full mode drops non-http links and other github.com URLs become web links', () => {
  const refs = full(
    '[f](file:///tmp/a) <mailto:a@b.example> https://github.com/acme/web https://github.com/acme/web/commit/abc',
  )
  expect(refs.map(r => r.category)).toEqual(['web', 'web'])
})

test('issue refs on file names are dropped', () => {
  expect(full('see src/a.ts#20 and docs/readme.md#3').length).toBe(0)
})

test('hostPath shortens long URLs to 60 chars with an ellipsis', () => {
  const h = hostPath('https://example.com/' + 'a'.repeat(100))
  expect(h.length).toBe(60)
  expect(h.endsWith('\u2026')).toBe(true)
  expect(hostPath('https://example.com/')).toBe('example.com')
})

// Each family has its input at `k` times the base size. At k = 4 it is about the size of the old fixed input, and at most
// the cap (200 000 characters; a scan reads no more, so a bigger input shows nothing). The backtick family grows with the
// square of its run count, so its run count grows with the square root of k.
const PATHOLOGICAL: Record<string, (k: number) => string> = {
  'backtick runs': k =>
    Array.from({ length: Math.round(300 * Math.sqrt(k)) }, (_, i) => '`'.repeat(i + 1) + 'a').join(' '),
  'link openers': k => '](a '.repeat(12_500 * k),
  'angle brackets': k => '<a#1 '.repeat(10_000 * k),
  'URL runs': k => 'https://a.b/'.repeat(4_100 * k) + ' #5',
  'an open fence': k => '```\n#1\n' + 'x#2\n'.repeat(12_500 * k),
}

for (const [family, make] of Object.entries(PATHOLOGICAL)) {
  test(`pathological inputs stay linear: ${family}`, async () => {
    await expectLinear({ label: family, make, run: text => extractRefs(text, { mode: 'full', defaultRepo: repo }) })
  })
}

test('parseRemote: single-letter host is not a remote', () => {
  expect(parseRemote('C:/work/repo')).toBeNull()
})

test('urls-only: a long punctuation run glued to a URL stays linear (trailing trim is linear)', async () => {
  const urlsOnly = (text: string) => extractRefs(text, { mode: 'urls-only', defaultRepo: null })
  await expectLinear({ make: k => 'https://github.com/a/b/issues/1' + '.'.repeat(25_000 * k) + 'x', run: urlsOnly })
  const refs = urlsOnly('https://github.com/a/b/issues/1' + '.'.repeat(100_000) + 'x')
  expect(refs.length).toBe(0) // the run is one URL that does not parse as an issue URL
  const ok = extractRefs('see https://github.com/a/b/issues/1.,;!? and (https://github.com/a/b/pull/2).', {
    mode: 'urls-only',
    defaultRepo: null,
  })
  expect(ok.map(r => (r.category === 'github' ? r.number : 0))).toEqual([1, 2])
})

test('hostPath stays linear on a long slash run that is not at the end', async () => {
  await expectLinear({
    make: k => '/'.repeat(25_000 * k) + 'x',
    run: slashes => {
      hostPath('https://e.com/' + slashes)
      hostPath('e.com/' + slashes)
    },
  })
})

test('a web URL longer than 2048 chars is not tracked', () => {
  const long = 'https://e.com/' + 'a'.repeat(3000)
  expect(full(`see ${long} and https://short.example/x`).map(r => r.url)).toEqual(['https://short.example/x'])
})

test('www.github.com is the same item as github.com', () => {
  expect(parseGitHubUrl('https://www.github.com/cli/cli/pull/1')).toEqual({
    category: 'github',
    host: 'github.com',
    owner: 'cli',
    repo: 'cli',
    number: 1,
    type: 'pr',
    url: 'https://github.com/cli/cli/pull/1',
  })
  expect(full('https://www.github.com/cli/cli/pull/1 and https://github.com/cli/cli/pull/1').length).toBe(1)
})

test('parseRemote: ssh.github.com is github.com', () => {
  expect(parseRemote('ssh://git@ssh.github.com:443/acme/web.git')).toEqual({
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
  })
})

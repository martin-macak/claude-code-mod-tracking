// Markdown file facts (issue #28). Pure code, so no `$` is used. The result shapes are the ones the design study
// observed on Claude Code 2.1.296 (issue #28, study part 1, section 3). The one exception is the `file_unchanged` answer
// of a Read (issue #245). It comes from probe P1 of the #57 study, on Claude Code 2.1.310.
import { expect, test } from 'claude-code/testing'
import { isIgnored, mdCandidates, resolvePath, touchFromToolResult } from '../trackers/file/files'
import { LIMITS } from './fixtures/limits'

const write = (filePath: string, type: 'create' | 'update' = 'create') => ({
  result: { type, filePath, content: '# x', structuredPatch: [], originalFile: null, userModified: false },
})
const edit = (filePath: string) => ({
  result: { filePath, oldString: 'a', newString: 'b', originalFile: 'a', structuredPatch: [], replaceAll: false },
})
const read = (filePath: string) => ({
  result: { type: 'text', file: { filePath, content: '# x', numLines: 1, startLine: 1, totalLines: 1 } },
})
// The answer of a second Read of a file that did not change (issue #245, probe P1 of the #57 study, Claude Code 2.1.310).
const readUnchanged = (filePath: string) => ({ result: { type: 'file_unchanged', file: { filePath } } })

// ---------------------------------------------------------------- paths

test('resolvePath: absolute stays, relative joins the cwd, ~/ joins HOME, ~ with no HOME gives null', () => {
  expect(resolvePath('/work/a.md', '/elsewhere')).toBe('/work/a.md')
  expect(resolvePath('notes.md', '/work')).toBe('/work/notes.md')
  expect(resolvePath('./docs/../plan.md', '/work/')).toBe('/work/plan.md')
  expect(resolvePath('~/x.md', '/work', '/home/u')).toBe('/home/u/x.md')
  expect(resolvePath('~/x.md', '/work')).toBeNull()
})

// ---------------------------------------------------------------- tool results

test('touchFromToolResult: Write create gives created, Write update and Edit give edited, Read gives viewed', () => {
  expect(touchFromToolResult('Write', write('/w/a.md'))).toEqual({ spelled: '/w/a.md', kind: 'created' })
  expect(touchFromToolResult('Write', write('/w/a.md', 'update'))).toEqual({ spelled: '/w/a.md', kind: 'edited' })
  expect(touchFromToolResult('Edit', edit('/w/a.md'))).toEqual({ spelled: '/w/a.md', kind: 'edited' })
  expect(touchFromToolResult('Read', read('/w/a.md'))).toEqual({ spelled: '/w/a.md', kind: 'viewed' })
})

test('touchFromToolResult: a Read of an unchanged file gives viewed with result.file.filePath for a .md path, in any case', () => {
  expect(touchFromToolResult('Read', readUnchanged('/w/a.md'))).toEqual({ spelled: '/w/a.md', kind: 'viewed' })
  expect(touchFromToolResult('Read', readUnchanged('/w/LOUD.MD'))).toEqual({ spelled: '/w/LOUD.MD', kind: 'viewed' })
  expect(touchFromToolResult('Read', readUnchanged('/w/a.ts'))).toBeNull() // only .md paths count
})

test('touchFromToolResult: a file_unchanged answer with source seeded, or as a transcript tool use, gives viewed', () => {
  // `source: 'seeded'` is a field of `file_unchanged` in the types file (claude-code.d.ts, 2.1.302). It was not seen live.
  const seeded = { result: { ...readUnchanged('/w/CLAUDE.md').result, source: 'seeded' } }
  expect(touchFromToolResult('Read', seeded)).toEqual({ spelled: '/w/CLAUDE.md', kind: 'viewed' })
  // A replay passes the whole tool use as `ran`. The input spells the path in another way on purpose: the path must
  // come from the result, as in the live call, and not from the input.
  const use = { tool_use_id: 't2', tool: 'Read', input: { file_path: 'a.md' }, ...readUnchanged('/w/a.md') }
  expect(touchFromToolResult(use.tool, use)).toEqual({ spelled: '/w/a.md', kind: 'viewed' })
})

test('touchFromToolResult: a file_unchanged answer with no usable path, an error or a staged call gives null', () => {
  expect(touchFromToolResult('Read', { result: { type: 'file_unchanged' } })).toBeNull()
  expect(touchFromToolResult('Read', { result: { type: 'file_unchanged', file: {} } })).toBeNull()
  expect(touchFromToolResult('Read', { result: { type: 'file_unchanged', file: { filePath: 1 } } })).toBeNull()
  expect(touchFromToolResult('Read', { isError: true, result: readUnchanged('/w/a.md').result })).toBeNull()
  expect(touchFromToolResult('Read', { result: { ...readUnchanged('/w/a.md').result, staged: true } })).toBeNull()
})

test('touchFromToolResult: only a Read call reads the file_unchanged type', () => {
  expect(touchFromToolResult('Write', readUnchanged('/w/a.md'))).toBeNull()
  expect(touchFromToolResult('Edit', readUnchanged('/w/a.md'))).toBeNull()
})

test('touchFromToolResult: only .md paths count, in any case', () => {
  for (const p of ['/w/a.ts', '/w/plan.md.bak', '/w/README', '/w/a.markdown'])
    expect(touchFromToolResult('Write', write(p))).toBeNull()
  expect(touchFromToolResult('Write', write('/w/LOUD.MD'))).toEqual({ spelled: '/w/LOUD.MD', kind: 'created' })
  expect(touchFromToolResult('Read', read('/w/a.ts'))).toBeNull()
})

test('touchFromToolResult: the observed failure shapes, a deny, a staged change and odd shapes give null', () => {
  const failed = {
    isError: true,
    result: "Error: Claude requested permissions to write to /repo/docs/denied.md, but you haven't granted it yet.",
  }
  expect(touchFromToolResult('Write', failed)).toBeNull()
  expect(touchFromToolResult('Write', { isError: true, result: write('/w/a.md').result })).toBeNull()
  expect(
    touchFromToolResult('Edit', { isError: true, result: 'Error: String to replace not found in file.' }),
  ).toBeNull()
  expect(touchFromToolResult('Write', { deny: 'blocked by a hook' })).toBeNull()
  expect(touchFromToolResult('Write', { result: { ...write('/w/a.md').result, staged: true } })).toBeNull()
  expect(touchFromToolResult('Write', { result: undefined })).toBeNull()
  expect(touchFromToolResult('Write', { result: { type: 'create' } })).toBeNull()
  expect(touchFromToolResult('Read', { result: { type: 'image', file: { base64: '' } } })).toBeNull()
  expect(touchFromToolResult('Bash', write('/w/a.md'))).toBeNull()
  expect(touchFromToolResult('Write', null)).toBeNull()
})

test('touchFromToolResult: a transcript tool use has the same shape and gives the same touch', () => {
  const use = { tool_use_id: 't1', tool: 'Write', input: { file_path: 'notes.md' }, ...write('notes.md') }
  expect(touchFromToolResult(use.tool, use)).toEqual({ spelled: 'notes.md', kind: 'created' })
})

// ---------------------------------------------------------------- ignore rule

const CTX = { root: '/work', configDir: '/home/u/.claude' }

test('isIgnored: .git and node_modules segments, in any case', () => {
  for (const p of ['/work/.git/notes.md', '/work/node_modules/pkg/README.md', '/work/NODE_MODULES/x.md'])
    expect(isIgnored(p, CTX)).toBe(true)
  for (const p of ['/elsewhere/.Git/x.md', '/elsewhere/node_modules/x.md']) expect(isIgnored(p, CTX)).toBe(true)
  expect(isIgnored('/work/docs/git/x.md', CTX)).toBe(false)
  expect(isIgnored('/work/docs/node_modules_old/x.md', CTX)).toBe(false)
})

test('isIgnored: a folder above the session root does not count', () => {
  const ctx = { root: '/srv/node_modules/tools/app', configDir: '/home/u/.claude' }
  expect(isIgnored('/srv/node_modules/tools/app/README.md', ctx)).toBe(false)
  expect(isIgnored('/srv/node_modules/tools/app/node_modules/x/README.md', ctx)).toBe(true)
})

test('isIgnored: auto-memory under the config dir; plans, CLAUDE.md and AGENTS.md stay', () => {
  expect(isIgnored('/home/u/.claude/projects/-work/memory/MEMORY.md', CTX)).toBe(true)
  expect(isIgnored('/home/u/.claude/projects/-work/memory/sub/a.md', CTX)).toBe(true)
  expect(isIgnored('/home/u/.claude/plans/p.md', CTX)).toBe(false)
  expect(isIgnored('/home/u/.claude/projects/-work/notes.md', CTX)).toBe(false)
  expect(isIgnored('/work/CLAUDE.md', CTX)).toBe(false)
  expect(isIgnored('/work/AGENTS.md', CTX)).toBe(false)
  expect(isIgnored('/work/projects/x/memory/notes.md', CTX)).toBe(false)
  // Another config dir (CLAUDE_CONFIG_DIR) moves the rule with it.
  const cfg = { root: '/work', configDir: '/cfg' }
  expect(isIgnored('/cfg/projects/x/memory/a.md', cfg)).toBe(true)
  expect(isIgnored('/home/u/.claude/projects/x/memory/b.md', cfg)).toBe(false)
  // No config dir known: no memory rule.
  expect(isIgnored('/home/u/.claude/projects/x/memory/b.md', { root: '/work' })).toBe(false)
})

test('isIgnored: everything under the autoMemoryDirectory setting', () => {
  const ctx = { ...CTX, memoryDir: '/mem' }
  expect(isIgnored('/mem/MEMORY.md', ctx)).toBe(true)
  expect(isIgnored('/mem/-work/notes.md', ctx)).toBe(true)
  expect(isIgnored('/memo/notes.md', ctx)).toBe(false)
  expect(isIgnored('/work/mem/notes.md', ctx)).toBe(false)
})

test('isIgnored: the Claude scratchpad by its engine shape, outside the session root only', () => {
  const pad = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/scratchpad'
  for (const base of ['/private/tmp/claude-501/-Users-me-repo', '/tmp/claude-1000/-home-u-proj', '/data/cc/claude-7/s'])
    expect(isIgnored(`${base}/${pad}/notes.md`, CTX)).toBe(true)
  // A session rooted inside the scratchpad keeps its own files.
  const root = `/private/tmp/claude-501/-Users-me-repo/${pad}/repo`
  expect(isIgnored(`${root}/docs/plan.md`, { root })).toBe(false)
  // A folder that is only named scratchpad, or has the wrong shape, stays.
  expect(isIgnored('/work/docs/scratchpad/notes.md', CTX)).toBe(false)
  expect(isIgnored('/home/u/scratchpad/proj/docs/plan.md', { root: '/home/u/scratchpad/proj' })).toBe(false)
  expect(isIgnored('/home/u/scratchpad/notes.md', CTX)).toBe(false)
  expect(isIgnored('/tmp/claude-501/a/b/Scratchpad/notes.md', CTX)).toBe(false)
})

// ---------------------------------------------------------------- mentions

test('mdCandidates: the observed reply gives its 8 candidates and skips the URL', () => {
  const reply =
    'Plan: `docs/plan.md`. See [alias](alias.md), ./notes.md, ../probe-repo/docs/sub.md, /repo/docs/after.md, ' +
    '~/x.md, docs/missing.md, README.md. URL <https://github.com/o/r/blob/main/CHANGELOG.md> and docs/plan.md.'
  expect(mdCandidates(reply)).toEqual([
    'docs/plan.md',
    'alias.md',
    './notes.md',
    '../probe-repo/docs/sub.md',
    '/repo/docs/after.md',
    '~/x.md',
    'docs/missing.md',
    'README.md',
  ])
})

test('mdCandidates: strips a line or anchor suffix, an @ prefix and trailing punctuation', () => {
  expect(mdCandidates('See README.md:42, docs/a.md:10:3 and docs/b.md#L7!')).toEqual([
    'README.md',
    'docs/a.md',
    'docs/b.md',
  ])
  expect(mdCandidates('Read @docs/plan.md? Then "notes.MD";')).toEqual(['docs/plan.md', 'notes.MD'])
  expect(mdCandidates('no files here, only a.mdx and b.markdown and .md')).toEqual([])
})

test('mdCandidates: at most maxMentionsPerRow, first ones first', () => {
  const text = Array.from({ length: LIMITS.maxMentionsPerRow + 5 }, (_, i) => `f${i}.md`).join(' ')
  const got = mdCandidates(text)
  expect(got).toHaveLength(LIMITS.maxMentionsPerRow)
  expect(got[0]).toBe('f0.md')
})

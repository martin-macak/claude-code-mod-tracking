// File facts (issues #28 and #57). Pure code, so no `$` is used. The result shapes are the ones the design study
// observed on Claude Code 2.1.296 (issue #28, study part 1, section 3). The exceptions are the answers of probe P1 of the
// #57 study, on Claude Code 2.1.310: the `file_unchanged` answer of a Read (issue #245), a Read of an image or a notebook,
// and NotebookEdit.
import { expect, test } from 'claude-code/testing'
import { isIgnored, isMd, pathCandidates, resolvePath, touchFromToolResult } from '../trackers/file/files'
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
})

test('touchFromToolResult: a Read of a file of any type is a view, a .md path or not', () => {
  expect(touchFromToolResult('Read', read('/w/src/a.ts'))).toEqual({ spelled: '/w/src/a.ts', kind: 'viewed' })
  expect(touchFromToolResult('Read', readUnchanged('/w/a.ts'))).toEqual({ spelled: '/w/a.ts', kind: 'viewed' })
  expect(touchFromToolResult('Read', readUnchanged('/w/Makefile'))).toEqual({ spelled: '/w/Makefile', kind: 'viewed' })
})

test('touchFromToolResult: a Read of a notebook, a PDF or parts names its file in result.file.filePath', () => {
  const nb = { result: { type: 'notebook', file: { filePath: '/w/nb.ipynb', cells: [] } } }
  const pdf = { result: { type: 'pdf', file: { filePath: '/w/doc.pdf', base64: '', originalSize: 193 } } }
  const parts = {
    result: {
      type: 'parts',
      file: { filePath: '/w/big.pdf', originalSize: 4096, count: 2, outputDir: '/tmp/claude-pages/big' },
    },
  }
  expect(touchFromToolResult('Read', nb)).toEqual({ spelled: '/w/nb.ipynb', kind: 'viewed' })
  expect(touchFromToolResult('Read', pdf)).toEqual({ spelled: '/w/doc.pdf', kind: 'viewed' })
  expect(touchFromToolResult('Read', parts)).toEqual({ spelled: '/w/big.pdf', kind: 'viewed' })
})

test('touchFromToolResult: a Read of an image has no path in its result, so the path is the input file_path', () => {
  const image = { result: { type: 'image', file: { base64: '…', type: 'image/png', originalSize: 70 } } }
  expect(touchFromToolResult('Read', image, { file_path: '/w/img.png' })).toEqual({
    spelled: '/w/img.png',
    kind: 'viewed',
  })
  expect(touchFromToolResult('Read', image)).toBeNull() // no input, no path
  expect(touchFromToolResult('Read', image, { file_path: 3 })).toBeNull()
  expect(touchFromToolResult('Read', image, 'text')).toBeNull()
  // A text result names its own file: the input does not matter.
  expect(touchFromToolResult('Read', read('/w/a.ts'), { file_path: 'other.ts' })).toEqual({
    spelled: '/w/a.ts',
    kind: 'viewed',
  })
})

test('touchFromToolResult: NotebookEdit edits the notebook, with error "" for a success', () => {
  const ok = (notebook_path: string, error: unknown = '') => ({
    result: { cell_type: 'code', edit_mode: 'replace', cell_id: 'c1', error, notebook_path },
  })
  expect(touchFromToolResult('NotebookEdit', ok('/w/nb.ipynb'))).toEqual({ spelled: '/w/nb.ipynb', kind: 'edited' })
  expect(touchFromToolResult('NotebookEdit', { result: { notebook_path: '/w/nb.ipynb' } })).toEqual({
    spelled: '/w/nb.ipynb',
    kind: 'edited',
  })
  // A failure is a string with isError, and a message in `error` is a failure too.
  const failed = { isError: true, result: 'Error: Cell with ID "nope" not found in notebook.' }
  expect(touchFromToolResult('NotebookEdit', failed)).toBeNull()
  expect(touchFromToolResult('NotebookEdit', ok('/w/nb.ipynb', 'Cell not found'))).toBeNull()
  expect(touchFromToolResult('NotebookEdit', { result: { error: '' } })).toBeNull()
  expect(touchFromToolResult('NotebookEdit', { result: { ...ok('/w/nb.ipynb').result, staged: true } })).toBeNull()
  expect(touchFromToolResult('Edit', ok('/w/nb.ipynb'))).toBeNull() // only NotebookEdit reads notebook_path
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

test('touchFromToolResult: a file of any type counts; a call with no path in its result does not', () => {
  for (const p of ['/w/a.ts', '/w/plan.md.bak', '/w/README', '/w/a.markdown', '/w/LOUD.MD'])
    expect(touchFromToolResult('Write', write(p))).toEqual({ spelled: p, kind: 'created' })
  expect(touchFromToolResult('Edit', edit('/w/src/a.ts'))).toEqual({ spelled: '/w/src/a.ts', kind: 'edited' })
  expect(touchFromToolResult('Write', { result: { type: 'create', filePath: '' } })).toBeNull()
  expect(touchFromToolResult('Glob', write('/w/a.ts'))).toBeNull() // a search is no read
  expect(touchFromToolResult('Grep', read('/w/a.ts'))).toBeNull()
})

test('isMd: a .md path in any case, with a name before the extension', () => {
  for (const p of ['/w/a.md', '/w/LOUD.MD', 'a.md']) expect(isMd(p)).toBe(true)
  for (const p of ['/w/a.ts', '/w/plan.md.bak', '/w/.md', '/w/a.markdown', '']) expect(isMd(p)).toBe(false)
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
  expect(touchFromToolResult('Bash', write('/w/a.md'))).toBeNull() // Bash has its own reader (`bash.ts`)
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

test('pathCandidates with scope md: the observed reply gives its 8 candidates and skips the URL', () => {
  const reply =
    'Plan: `docs/plan.md`. See [alias](alias.md), ./notes.md, ../probe-repo/docs/sub.md, /repo/docs/after.md, ' +
    '~/x.md, docs/missing.md, README.md. URL <https://github.com/o/r/blob/main/CHANGELOG.md> and docs/plan.md.'
  expect(pathCandidates(reply, undefined, 'md')).toEqual([
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

test('pathCandidates with scope md: strips a line or anchor suffix, an @ prefix and trailing punctuation', () => {
  expect(pathCandidates('See README.md:42, docs/a.md:10:3 and docs/b.md#L7!', undefined, 'md')).toEqual([
    'README.md',
    'docs/a.md',
    'docs/b.md',
  ])
  expect(pathCandidates('Read @docs/plan.md? Then "notes.MD";', undefined, 'md')).toEqual(['docs/plan.md', 'notes.MD'])
  expect(pathCandidates('no files here, only a.mdx and b.markdown and .md', undefined, 'md')).toEqual([])
})

test('pathCandidates with scope md: at most maxMentionsPerRow, first ones first', () => {
  const text = Array.from({ length: LIMITS.maxMentionsPerRow + 5 }, (_, i) => `f${i}.md`).join(' ')
  const got = pathCandidates(text, undefined, 'md')
  expect(got).toHaveLength(LIMITS.maxMentionsPerRow)
  expect(got[0]).toBe('f0.md')
})

// ---------------------------------------------------------------- mentions of any path (issue #57, R2)

test('pathCandidates: a path, a known extension or a known name is a candidate; prose and repos are not', () => {
  const text =
    'Edit src/a.ts and package.json, then Makefile and ./run, ../up/x, ~/y, /etc/hosts, /track and Next.js e.g. 1/2 ' +
    'v2.1.310 example.com plus .env, src/ and a/b.weird and node.js and/or acme/web#5 src/core 3.14/2 and ./ and /x/ ' +
    'and bin/deploy but ./bin/deploy'
  expect(pathCandidates(text)).toEqual([
    'src/a.ts',
    'package.json',
    'Makefile',
    './run',
    '../up/x',
    '~/y',
    '/etc/hosts',
    'Next.js', // a known extension: the stat finds no such file
    '.env',
    'a/b.weird',
    'node.js',
    './bin/deploy', // a relative path with no extension needs a lead: `bin/deploy` is no candidate (README, Mentions)
  ])
})

test('pathCandidates: a ratio with a decimal part is no path', () => {
  expect(pathCandidates('ratio 1/2.5 and 10/3.5 here')).toEqual([])
})

test('pathCandidates: skips a URL, cuts a line number, an anchor, an @ and punctuation, keeps each path once', () => {
  expect(
    pathCandidates('See <https://github.com/o/r/blob/main/a.ts>, src/a.ts:42:7, @src/b.ts#L7! and `src/a.ts`.'),
  ).toEqual(['src/a.ts', 'src/b.ts'])
  expect(pathCandidates('x'.repeat(600) + '/a.ts and short/a.ts')).toEqual(['short/a.ts']) // a 600-character word is no path
})

test('pathCandidates: at most max, and 0 reads none; scope md keeps the .md paths of before', () => {
  expect(pathCandidates('a.ts b.ts c.ts', 2)).toEqual(['a.ts', 'b.ts'])
  expect(pathCandidates('a.ts b.ts', 0)).toEqual([])
  const text = 'src/a.ts docs/plan.md README.md Makefile notes.MD'
  expect(pathCandidates(text, 20, 'md')).toEqual(['docs/plan.md', 'README.md', 'notes.MD'])
  expect(pathCandidates(text, undefined, 'md')).toEqual(['docs/plan.md', 'README.md', 'notes.MD'])
  expect(pathCandidates(text)).toEqual(['src/a.ts', 'docs/plan.md', 'README.md', 'Makefile', 'notes.MD'])
})

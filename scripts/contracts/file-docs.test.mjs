// The README and the KB say what the Files section tracks (issues #57 and #252). The code is the source: the config keys of the
// file tracker, the types and the names the type map knows, the views that exist, the files of `trackers/file/`, and the
// first line of the prompt. A key that a doc does not list is a switch the person cannot find, a type row that the map does
// not give is a promise it does not keep, and a README that claims a view the code lacks sends the reader to a key that is not
// there. Prose beyond these anchors has no test: a contract on wording would be overfit. The kit has no fs, so this check runs
// under node in `make test-scripts`.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/file-docs.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { VIEW_IDS } from '../../plugins/artifact-tracking/core/lib/grouping.ts'
import { readOnlyLine } from '../../plugins/artifact-tracking/trackers/file/activity.ts'
import { FILE_DEFAULTS } from '../../plugins/artifact-tracking/trackers/file/config.ts'
import { FILE_TYPES, typeOfName } from '../../plugins/artifact-tracking/trackers/file/file-type.ts'
import { filePrompt } from '../../plugins/artifact-tracking/trackers/file/prompt.ts'

const path = rel => fileURLToPath(new URL(rel, import.meta.url))
const read = rel => readFileSync(path(rel), 'utf8')
const README = read('../../plugins/artifact-tracking/README.md')
const KB = '../../docs/knowledge-base/claude-code-mods/'
const KB_README = read(`${KB}README.md`)
const PAGE_PATH = `${KB}concepts/file-signals.md`

/** The text from the line that starts with `from` up to the line that starts with `to`. */
function between(text, from, to) {
  const start = text.indexOf(`\n${from}`)
  assert.ok(start >= 0, `the README has a line that starts with ${from}`)
  const end = text.indexOf(`\n${to}`, start + 1)
  assert.ok(end > start, `the README has a line that starts with ${to} after it`)
  return text.slice(start, end)
}
const FILES = between(README, '### Files', '## Priority')
const TYPES = between(README, '#### Types of files', '## Priority')

/** The one line of `text` that starts with `prefix`. */
function lineOf(text, prefix) {
  const lines = text.split('\n').filter(l => l.startsWith(prefix))
  assert.equal(lines.length, 1, `exactly one line starts with ${prefix}`)
  return lines[0]
}

test('every key of the file config except `enabled` and `prompt` has a README Configuration row with its default', () => {
  const keys = Object.keys(FILE_DEFAULTS).filter(k => k !== 'enabled' && k !== 'prompt')
  for (const key of ['scope', 'maxMentionsPerRow', 'maxFiles', 'bashEdits', 'mime'])
    assert.ok(keys.includes(key), `the schema has ${key}`)
  for (const key of keys) {
    const row = README.split('\n').find(l => l.startsWith(`| \`trackers.file.${key}\` |`))
    assert.ok(row, `the README table has a row for trackers.file.${key}`)
    // The default is the second cell, in backticks when it is a word.
    assert.equal(row.split('|')[2].trim().replaceAll('`', ''), String(FILE_DEFAULTS[key]), row)
  }
})

/** The file name that a backticked token of the types table stands for: a pattern gets a sample name, an extension a dot name. */
function sample(token) {
  const name = token.replaceAll('<name>', 'x').replaceAll('*', 'x')
  return /^[a-z0-9]+$/.test(name) ? `file.${name}` : name
}

test('the types table has a row for each type, and the map gives that type for every name and extension in it', () => {
  const rows = new Map(
    TYPES.split('\n')
      .filter(l => l.startsWith('| `'))
      .map(l => {
        const [, type, tokens] = l.split('|').map(c => c.trim())
        return [type.replaceAll('`', ''), tokens]
      }),
  )
  assert.deepEqual([...rows.keys()], [...FILE_TYPES], 'one row for each type, in the order of the sort')
  for (const [type, cell] of rows) {
    if (type === 'other') continue
    // A backticked span is a word list (`ts tsx js`) or one name (`Makefile`, `.env.*`).
    const tokens = [...cell.matchAll(/`([^`]+)`/g)].flatMap(m => m[1].split(/\s+/))
    assert.ok(tokens.length > 0, `the ${type} row names something`)
    for (const token of tokens) {
      const name = sample(token)
      assert.equal(
        typeOfName(name),
        type,
        `${token} (as ${name}) is ${type} in the README; the map says ${typeOfName(name)}`,
      )
    }
  }
})

test('the Files section claims a view by type only when a view by type exists, and names the issue of the follow-up when none does', () => {
  const hasKindView = VIEW_IDS.includes('kind')
  assert.ok(!FILES.includes('A view can group by it'), 'no view groups by the type of a file in the code')
  assert.equal(
    FILES.includes('No view groups by it yet'),
    !hasKindView,
    'the type row says whether a view groups by it',
  )
  if (!hasKindView) assert.ok(FILES.includes('/issues/248'), 'the row links the follow-up that adds the view')
})

test('the code-map row of trackers/file/ names the files that read Bash, type a file and ask for the MIME type', () => {
  const row = lineOf(README, '| `trackers/file/` |')
  for (const file of ['activity.ts', 'bash.ts', 'file-type.ts', 'mime.ts'])
    assert.ok(row.includes(file), `${file} is in: ${row}`)
  assert.ok(!row.includes('Markdown path scanner'), 'the tracker takes any file now')
})

test('the Bash rule says when Claude Code records bashEditDiff and what the field leaves out', () => {
  const rule = lineOf(FILES, '- Bash:')
  for (const word of [
    'bashEditDiffEnabled',
    'bypassPermissions',
    'auto mode',
    'ignored',
    'submodule',
    '200',
    'first 5',
  ])
    assert.ok(rule.includes(word), `the Bash rule names "${word}"`)
})

test('the prompt lines of the files start with the line that counts the read ones, and the README says so', () => {
  const file = (name, over) => ({
    key: `file:/w/${name}`,
    category: 'file',
    url: `/w/${name}`,
    label: `/w/${name}`,
    created: false,
    edits: 0,
    views: 0,
    mentions: 0,
    sources: ['tool'],
    reasons: { all: ['read'], strongest: 'read' },
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
    ...over,
  })
  const items = [
    file('w.ts', { created: true, reasons: { all: ['created'], strongest: 'created' } }),
    file('r.ts', { views: 1 }),
  ]
  const lines = filePrompt({ items, isDismissed: () => false, root: '/w' })
  assert.equal(lines[0], `file: ${readOnlyLine(1)}`, 'the first line counts the files that were only read')
  const rule = lineOf(README, '- Items come in the order of the pane:')
  assert.ok(rule.includes('start with one line that counts the files that were only read'), rule)
  assert.ok(!rule.includes('end with one line'), 'the count is not the last line any more')
})

test('the KB map links the page of file signals, and the page names the keys, the cap rank, the field and the seven types', () => {
  assert.ok(KB_README.includes('(concepts/file-signals.md)'), 'the map of the KB README links concepts/file-signals.md')
  assert.ok(existsSync(path(PAGE_PATH)), 'the page exists')
  const page = read(PAGE_PATH)
  for (const word of [
    'scope',
    'maxFiles',
    'bashEdits',
    'mime',
    'capRank',
    'bashEditDiff',
    'bashEditDiffEnabled',
    ...FILE_TYPES,
  ])
    assert.ok(page.includes(word), `the page names ${word}`)
  assert.ok(page.includes('plugins/artifact-tracking/README.md#files'), 'the page links the README section')
})

test('the plugin description and the /track command description say that the mod tracks files, not Markdown files only', () => {
  const manifest = JSON.parse(read('../../plugins/artifact-tracking/.claude-plugin/plugin.json'))
  const register = read('../../plugins/artifact-tracking/hooks/register.tsx')
  const command = register.match(/name: 'track',\s*description: '([^']*)'/)?.[1]
  assert.ok(command, 'register.tsx gives the track command a description')
  for (const [where, text] of [
    ['plugin.json', manifest.description],
    ['the /track command', command],
  ]) {
    assert.ok(!/markdown/i.test(text), `${where} still says Markdown: ${text}`)
    assert.ok(/\bfiles\b/.test(text), `${where} names the files: ${text}`)
  }
  assert.ok(manifest.description.includes('of any type'), manifest.description)
})

test('the KB page grades the limit of 5 diffs as a primary source, and the line it cites says so', () => {
  const bullet = lineOf(read(PAGE_PATH), '- **The flags cover few files.**')
  const link = bullet.match(/\(\.\.\/sources\/(code-claude-com-[^/]+\/hooks\/hooks\.md)#L(\d+)\)/)
  assert.ok(link, `the bullet links the line of the docs snapshot: ${bullet}`)
  const cited = read(`${KB}sources/${link[1]}`).split('\n')[Number(link[2]) - 1]
  assert.ok(cited.includes('up to 5 changed files'), `line ${link[2]} of ${link[1]} is: ${cited}`)
  assert.ok(bullet.includes('`[primary source]`'), 'the limit has the grade of the types and the docs')
})

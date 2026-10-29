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
import { FILE_DEFAULTS, HEAD_BYTES } from '../../plugins/artifact-tracking/trackers/file/config.ts'
import { OFF_TTL_MS } from '../../plugins/artifact-tracking/trackers/file/diff-off.ts'
import { FACT_BRANCH_PR, FACT_DIFF_OFF } from '../../plugins/artifact-tracking/trackers/file/facts.ts'
import { FILE_TYPES, typeOfName } from '../../plugins/artifact-tracking/trackers/file/file-type.ts'
import {
  DIFF_FLAGS,
  DIFF_MAX_BYTES,
  DIFF_NOTICES,
  GIT_PIN,
} from '../../plugins/artifact-tracking/trackers/file/git-diff.ts'
import { filePrompt } from '../../plugins/artifact-tracking/trackers/file/prompt.ts'
import { isSecretPath } from '../../plugins/artifact-tracking/trackers/file/secret.ts'
import { BUDGET } from '../../plugins/artifact-tracking/ux/tree-data-table/budget.ts'

const path = rel => fileURLToPath(new URL(rel, import.meta.url))
const read = rel => readFileSync(path(rel), 'utf8')
const README = read('../../plugins/artifact-tracking/README.md')
const KB = '../../docs/knowledge-base/claude-code-mods/'
const KB_README = read(`${KB}README.md`)
const GIT_DIFF_SOURCE = read('../../plugins/artifact-tracking/trackers/file/git-diff.ts')
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

/**
 * The config keys of a defaults tree as `[path, default]`: a nested block (`preview`) gives one entry for each key under it
 * (`preview.maxLines`), and a list is kept whole. The `prompt` block has its own table and is left out.
 */
function keysOf(defaults, prefix = '') {
  return Object.entries(defaults).flatMap(([key, value]) => {
    const path = `${prefix}${key}`
    if (path === 'enabled' || path === 'prompt') return []
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? keysOf(value, `${path}.`)
      : [[path, value]]
  })
}

test('every key of the file config except `enabled` and `prompt` has a README Configuration row with its default', () => {
  const keys = keysOf(FILE_DEFAULTS)
  for (const key of [
    'scope',
    'maxMentionsPerRow',
    'maxFiles',
    'bashEdits',
    'mime',
    'secretPaths',
    'preview.maxLines',
    'preview.maxChars',
  ])
    assert.ok(
      keys.some(([path]) => path === key),
      `the schema has ${key}`,
    )
  for (const [key, value] of keys) {
    const row = README.split('\n').find(l => l.startsWith(`| \`trackers.file.${key}\` |`))
    assert.ok(row, `the README table has a row for trackers.file.${key}`)
    // The default is the second cell, in backticks when it is a word. A list is its JSON text, `[]` when empty.
    const shown = Array.isArray(value) ? JSON.stringify(value) : String(value)
    assert.equal(row.split('|')[2].trim().replaceAll('`', ''), shown, row)
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

test('the code-map row of trackers/file/ also names the secret rule and the preview', () => {
  const row = lineOf(README, '| `trackers/file/` |')
  for (const file of ['secret.ts', 'preview.ts']) assert.ok(row.includes(file), `${file} is in: ${row}`)
})

test('the Preview section lists the secret files by the names the rule treats as secret, and the templates it lets through', () => {
  const rule = lineOf(FILES, '- Secret files:')
  const list = rule.slice(rule.indexOf('The fixed rule'), rule.indexOf('The rule reads'))
  const tokens = [...list.matchAll(/`([^`]+)`/g)].map(m => m[1])
  const templates = ['.env.example', '.env.sample', '.env.template']
  assert.ok(tokens.length >= 16, `the rule lists its names: ${tokens.join(' ')}`)
  for (const name of templates) assert.ok(tokens.includes(name), `the rule names the template ${name}`)
  const folders = ['.ssh', '.gnupg', '.aws', '.kube', '.config/gh']
  for (const token of tokens) {
    // A folder token is a file below it, a pattern gets a sample name, a plain name is itself.
    const path = folders.includes(token)
      ? `/home/u/${token}/x`
      : token.includes('/')
        ? `/home/u/${token}`
        : `/w/${token.replaceAll('*', 'x')}`
    assert.equal(isSecretPath(path), !templates.includes(token), `${token} (as ${path})`)
  }
  assert.ok(rule.includes('trackers.file.secretPaths'), 'the rule names the config key that adds globs')
})

test('the Preview section and the Keys table name the keys v and r, Esc, the caps and the head call, as the code has them', () => {
  const preview = between(README, '#### Preview of a file', '#### Types of files')
  for (const word of [
    '`v`',
    '`r`',
    'Esc',
    `head -c ${HEAD_BYTES}`,
    `${FILE_DEFAULTS.preview.maxLines.toLocaleString('en-US')} by default`,
    `${FILE_DEFAULTS.preview.maxChars.toLocaleString('en-US')} by default`,
    `${BUDGET.chars.toLocaleString('en-US')} characters`,
    'NUL',
    'CRLF',
  ])
    assert.ok(preview.includes(word), `the Preview section names ${word}`)
  const key = README.split('\n').find(l => l.startsWith('| `v` |'))
  assert.ok(key?.includes('#preview-of-a-file'), 'the Keys table row of v links the Preview section')
  assert.equal(FILE_DEFAULTS.preview.maxLines, 2000)
  assert.equal(FILE_DEFAULTS.preview.maxChars, 60000)
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

// Issue #254, L3 of #57: the diff mode of the preview. The code is the source: `DIFF_NOTICES` (every notice of the mode), `GIT_PIN` and
// `DIFF_FLAGS` (the git options), the byte limit, the two facts and the time that an answer holds. The README says them in its Diff
// section, the KB in the tree-table page and the file-signals page, and a README Known limits bullet keeps its own line.
const DIFF = between(README, '#### Diff of a file', '#### Types of files')
const LIMITS = between(README, '## Known limits', '## Develop')
const TREE_TABLE = read('../../docs/knowledge-base/claude-code-mod-architecture/tree-table.md')
const DIFF_KB = between(TREE_TABLE, '#### The diff mode (issue #254)', '### 5.6')
const SIGNALS_DIFF = between(read(PAGE_PATH), '## What the diff reads', '## Not tested')
const SCENARIOS = read('../../e2e/features/pane.feature').split('\n')
/** The line of the scenario of `v` (the one of the preview): the docs cite it too, and it is no diff scenario. A line number is a pin, so it is found, not typed. */
const PREVIEW_SCENARIO = SCENARIOS.findIndex(l => l.trim().startsWith('Scenario: v opens the preview')) + 1

/** The fixed parts of a notice: a text, or a function of strings that gets a mark for each part that changes. A part of 12 characters or more counts. */
const MARK = '\u0001'
const fragmentsOf = text =>
  text
    .split(MARK)
    .map(f => f.trim())
    .filter(f => f.length >= 12)
const NOTICES = Object.entries(DIFF_NOTICES).map(([name, v]) => [
  name,
  fragmentsOf(typeof v === 'string' ? v : v(...Array(v.length).fill(MARK))),
])

test('the Diff section names the pinned git options, the byte limit and the facts, as the code has them', () => {
  for (const option of [...GIT_PIN, ...DIFF_FLAGS].filter(o => o !== '-c'))
    assert.ok(DIFF.includes(option), `the Diff section names ${option}`)
  assert.ok(DIFF.includes(DIFF_MAX_BYTES.toLocaleString('en-US')), 'the Diff section names the limit in bytes')
  assert.ok(DIFF.includes(`\`${FACT_BRANCH_PR}\``), 'the Diff section names the fact of the PR')
  assert.ok(DIFF.includes(`\`${FACT_DIFF_OFF}\``), 'the Diff section names the fact that turns the mode off')
  assert.ok(
    DIFF.includes(`${OFF_TTL_MS / 1000} s`),
    `the Diff section says that an answer holds ${OFF_TTL_MS / 1000} s`,
  )
  for (const word of [
    'origin/HEAD',
    'merge-base',
    '--no-index',
    'ls-files',
    'LC_ALL=C',
    'no shell',
    'git fetch',
    'cat-file',
  ])
    assert.ok(DIFF.includes(word), `the Diff section names ${word}`)
})

test('the Diff section gives every notice of the code, built from DIFF_NOTICES: a new or a reworded notice fails until the README says it', () => {
  assert.ok(NOTICES.length >= 20, 'the table has the notices of the mode')
  for (const [name, fragments] of NOTICES) {
    assert.ok(fragments.length > 0, `the notice ${name} has a fixed part of 12 characters or more to check`)
    for (const fragment of fragments) assert.ok(DIFF.includes(fragment), `the Diff section says ${name}: ${fragment}`)
  }
  // No notice of git-diff.ts is written out of the table: one that is would have no check above.
  assert.ok(!/\bnotice\(\s*['"`]/.test(GIT_DIFF_SOURCE), 'every notice of git-diff.ts comes from DIFF_NOTICES')
  const preview = between(README, '#### Preview of a file', '#### Diff of a file')
  assert.ok(preview.includes('Press d for the diff.'), 'the Preview section says the hint of a file that is gone')
})

test('the KB pages of the diff mode name what the code has, and link the README section', () => {
  for (const word of [
    'git-diff.ts',
    'diff-base.ts',
    'diff-text.ts',
    'diff-off.ts',
    'facts.ts',
    'branch-pr.ts',
    'isBranchPr',
    FACT_BRANCH_PR,
    FACT_DIFF_OFF,
    DIFF_MAX_BYTES.toLocaleString('en-US'),
    `${OFF_TTL_MS / 1000} s`,
  ])
    assert.ok(DIFF_KB.includes(word), `the tree-table page names ${word}`)
  assert.ok(DIFF_KB.includes('README.md#diff-of-a-file'), 'the tree-table page links the README section')
  for (const option of [...GIT_PIN, ...DIFF_FLAGS].filter(o => o !== '-c'))
    assert.ok(SIGNALS_DIFF.includes(option), `the file-signals page names ${option}`)
  for (const word of [
    DIFF_MAX_BYTES.toLocaleString('en-US'),
    FACT_BRANCH_PR,
    FACT_DIFF_OFF,
    'LC_ALL=C',
    'README.md#diff-of-a-file',
  ])
    assert.ok(SIGNALS_DIFF.includes(word), `the file-signals page names ${word}`)
  const row = lineOf(KB_README, '| | [file-signals]')
  assert.ok(
    row.includes('diff') && row.includes('#254'),
    `the KB map row of file-signals names the diff and #254: ${row}`,
  )
})

test('the e2e scenarios that the docs cite are the diff scenarios: a line that starts with `Scenario: d`', () => {
  const docs = DIFF_KB + LIMITS
  const cited = [...docs.matchAll(/pane\.feature:(\d+)/g)].map(m => Number(m[1]))
  assert.ok(cited.length > 0, 'the docs cite the live scenarios')
  for (const n of new Set(cited.filter(n => n !== PREVIEW_SCENARIO))) {
    assert.ok(
      SCENARIOS[n - 1]?.trim().startsWith('Scenario: d'),
      `pane.feature:${n} is a diff scenario: ${SCENARIOS[n - 1]}`,
    )
  }
})

test('Known limits has a bullet of its own for the diff mode, on its own line, with the caveats of the code', () => {
  const bullet = lineOf(LIMITS, '- **Diff.**')
  for (const word of ['git fetch', 'origin/HEAD', FACT_BRANCH_PR, FACT_DIFF_OFF])
    assert.ok(bullet.includes(word), `the Diff bullet names ${word}`)
  assert.ok(
    !LIMITS.split('\n').some(l => /\S- \*\*/.test(l)),
    'no Known limits line holds a second bullet glued to the first',
  )
})

test('the Keys table row of d links the Diff section and the help view lists d, and the code map names the diff files and the facts', () => {
  const key = README.split('\n').find(l => l.startsWith('| `v` |'))
  assert.ok(key?.includes('#diff-of-a-file'), 'the Keys table row of v links the Diff section')
  assert.ok(key?.includes('the help view lists'), 'the Keys table row says that the help view lists d')
  assert.ok(!key?.includes('held for'), 'the row says no more that d is held for a later layer')
  const preview = between(README, '#### Preview of a file', '#### Diff of a file')
  assert.ok(preview.includes('`d: diff`'), 'the key line of the preview names d')
  assert.ok(!preview.includes('There is no `d` yet'), 'the Preview section says no more that there is no d')
  const files = lineOf(README, '| `trackers/file/` |')
  for (const file of ['git-diff.ts', 'diff-base.ts', 'diff-text.ts', 'diff-off.ts', 'facts.ts', 'notice.ts'])
    assert.ok(files.includes(file), `${file} is in: ${files}`)
  const github = lineOf(README, '| `trackers/github/` |')
  for (const word of ['branch-pr.ts', 'github.branchPr']) assert.ok(github.includes(word), `${word} is in: ${github}`)
})

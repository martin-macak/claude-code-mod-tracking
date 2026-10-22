// Tracker contracts (spec 5.1 dependency rules, spec 7 "Contract checks"; plan L5, Task 16; decisions K7 and K8; L6).
// Two kinds of check keep tracker code inside `trackers/`:
//   names:   the words github, jira, gh and acli appear in no file of core/, ux/, types/ or hooks/ (K8), except the
//            one line of the composition root `hooks/register.tsx` that describes the command it registers. A line that
//            holds one fails, a comment included.
//   imports: each folder imports only what spec 5.1 lets it import, and a `trackers/<id>/` path appears outside its
//            folder only in `trackers/index.ts`.
// The kit has no fs, so this check runs under node in `make test-scripts`.
// Run: node --test scripts/contracts/tracker-contracts.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = fileURLToPath(new URL('../../plugins/artifact-tracking/', import.meta.url))

/** The folders whose files may not name a tracker (K8). L6 deleted the legacy draw path, so `hooks/` joins. */
const NAMELESS = ['core', 'ux', 'types', 'hooks']
/** The composition root. It builds the `tools` atom from the trackers' specs, so only the command text names trackers. */
const NAMING_ROOT = 'hooks/register.tsx'
const TRACKER_NAMES = /\b(github|jira|gh|acli)\b/i
/** The lines that may name a tracker, by file, as `hits` prints them: the description of the command (K8). */
const NAMING_LINES = { [NAMING_ROOT]: /^hooks\/register\.tsx:\d+: description: 'Show tracked [^']*',$/ }
/** The lines of `file` that name a tracker and are not on the allowlist. */
const namedLines = file => hits(file, TRACKER_NAMES).filter(line => !NAMING_LINES[file]?.test(line))

// ---------------------------------------------------------------- reading the tree

/** Every `.ts`, `.tsx` and `.d.ts` file under `roots`, as a posix path relative to the plugin. */
function sourcesUnder(roots) {
  const out = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) out.push(relative(PLUGIN, path).split(sep).join('/'))
    }
  }
  for (const root of roots) walk(join(PLUGIN, root))
  return out.sort()
}

const textOf = file => readFileSync(join(PLUGIN, file), 'utf8')
const lineOf = (text, index) => text.slice(0, index).split('\n').length
const isComment = line => /^\s*(?:\/\/|\/?\*)/.test(line)

/** The `file:line: text` of each line of `file` that `pattern` matches. */
function hits(file, pattern) {
  return textOf(file)
    .split('\n')
    .flatMap((text, i) => (pattern.test(text) ? [`${file}:${i + 1}: ${text.trim()}`] : []))
}

// ---------------------------------------------------------------- the import parser

// A static clause may span lines. It holds names, braces, commas, stars and `as`/`type` words, never code, so the
// clause stops at the first character a real declaration cannot hold. Files have no semicolons: anchor at line start. The
// anchor allows indent (`[ \t]*`, never `\s`, which would swallow the lines before): an import inside a
// `declare module '...' { }` block is indented.
const STATIC_FROM = /^[ \t]*(?:import|export)\s+[\w\s{},*$]*?\bfrom\s*['"]([^'"\n]+)['"]/gm
const STATIC_BARE = /^[ \t]*import\s+['"]([^'"\n]+)['"]/gm
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

/**
 * Every module specifier that `text` imports: `{ spec, line }`. It reads `import ... from`, `export ... from`, a bare
 * `import '<spec>'` and a dynamic `import('<spec>')`. A hit inside a comment line does not count.
 */
export function importsOf(text) {
  const found = []
  for (const re of [STATIC_FROM, STATIC_BARE, DYNAMIC]) {
    for (const m of text.matchAll(re)) {
      const line = lineOf(text, m.index)
      if (!isComment(text.split('\n')[line - 1])) found.push({ spec: m[1], line })
    }
  }
  return found.sort((a, b) => a.line - b.line || (a.spec < b.spec ? -1 : 1))
}

const isRelative = spec => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')

/** The suffixes a relative specifier may resolve to, in the order the loader tries them. */
const SUFFIXES = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '/index.d.ts']

/** The plugin-relative path a relative `spec` of `file` names, or `null` when no file is there. */
function resolveSpec(file, spec, exists = existsFile) {
  const base = normalize(join(dirname(file), spec))
    .split(sep)
    .join('/')
  for (const suffix of SUFFIXES) if (exists(base + suffix)) return base + suffix
  return null
}

function existsFile(path) {
  const full = join(PLUGIN, path)
  return existsSync(full) && statSync(full).isFile()
}

/** `file` to its imports: `{ spec, line, target }`, where `target` is the resolved path, `null` for a package. */
function graphOf(files, read = textOf, exists = existsFile) {
  const graph = new Map()
  for (const file of files) {
    graph.set(
      file,
      importsOf(read(file)).map(({ spec, line }) => ({
        spec,
        line,
        target: isRelative(spec) ? resolveSpec(file, spec, exists) : null,
      })),
    )
  }
  return graph
}

// ---------------------------------------------------------------- the rules

const inFolder = (file, folder) => file.startsWith(`${folder}/`)
/** `trackers/<id>` of a path under `trackers/<id>/`, else `null`. `trackers/index.ts` has none. */
const trackerOf = file => /^trackers\/([^/]+)\//.exec(file)?.[1] ?? null

/**
 * The imports of `graph` that break `rule`. `rule.scope(file)` picks the importers. `rule.allows(target, file, spec)` says
 * whether an import may resolve there. A rule with `packages` judges a package import too: it fails. An import that does
 * not resolve is a failure of its own: a rule cannot judge it.
 */
export function violations(graph, rule) {
  const found = []
  for (const [file, imports] of graph) {
    if (!rule.scope(file)) continue
    for (const { spec, line, target } of imports) {
      if (!isRelative(spec)) {
        if (rule.packages) found.push(`${file}:${line}: imports ${spec}`)
      } else if (target === null) found.push(`${file}:${line}: ${spec} resolves to no file`)
      else if (!rule.allows(target, file, spec)) found.push(`${file}:${line}: imports ${spec} (${target})`)
    }
  }
  return found
}

const RULES = {
  core: {
    name: 'core imports nothing of hooks, trackers or ux, in any of its folders',
    scope: f => inFolder(f, 'core'),
    allows: t => !inFolder(t, 'hooks') && !inFolder(t, 'trackers') && !inFolder(t, 'ux'),
  },
  interfaces: {
    name: 'core/interfaces imports only core/interfaces and types',
    scope: f => inFolder(f, 'core/interfaces'),
    allows: t => inFolder(t, 'core/interfaces') || inFolder(t, 'types'),
  },
  lib: {
    name: 'core/lib imports only core/lib, core/interfaces and types',
    scope: f => inFolder(f, 'core/lib'),
    allows: t => inFolder(t, 'core/lib') || inFolder(t, 'core/interfaces') || inFolder(t, 'types'),
  },
  infra: {
    name: 'core/infra imports only core/infra, core/interfaces and core/lib',
    scope: f => inFolder(f, 'core/infra'),
    allows: t => inFolder(t, 'core/infra') || inFolder(t, 'core/interfaces') || inFolder(t, 'core/lib'),
  },
  ux: {
    name: 'ux imports only core/interfaces and ux',
    scope: f => inFolder(f, 'ux'),
    allows: t => inFolder(t, 'core/interfaces') || inFolder(t, 'ux'),
  },
  tracker: {
    name: 'a tracker imports only core/interfaces, core/lib and its own folder',
    scope: f => trackerOf(f) !== null,
    allows: (t, f) =>
      inFolder(t, 'core/interfaces') || inFolder(t, 'core/lib') || inFolder(t, `trackers/${trackerOf(f)}`),
  },
  index: {
    name: 'trackers/index.ts imports only trackers/<id>/index.ts and core/interfaces',
    scope: f => f === 'trackers/index.ts',
    allows: t => inFolder(t, 'core/interfaces') || /^trackers\/[^/]+\/index\.ts$/.test(t),
  },
  outside: {
    name: 'a trackers/<id>/ path appears outside its folder only in trackers/index.ts',
    scope: f => trackerOf(f) === null && f !== 'trackers/index.ts' && !inFolder(f, 'tests'),
    allows: t => trackerOf(t) === null,
  },
  register: {
    name: 'register.tsx imports trackers only through trackers/index.ts',
    scope: f => f === 'hooks/register.tsx',
    allows: t => !inFolder(t, 'trackers') || t === 'trackers/index.ts',
  },
  types: {
    name: 'types imports nothing',
    scope: f => inFolder(f, 'types'),
    allows: () => false,
    packages: true,
  },
}

// The rules judge the whole tree except tests/, whose files may import anything.
const GRAPH = graphOf(sourcesUnder(['core', 'ux', 'trackers', 'hooks', 'types']))

function assertClean(rule) {
  const found = violations(GRAPH, rule)
  assert.deepEqual(found, [], `${rule.name}:\n${found.join('\n')}`)
}

// ---------------------------------------------------------------- names

test('no tracker name in core, ux, types or hooks, but the command text of the composition root', () => {
  const files = sourcesUnder(NAMELESS)
  const found = files.flatMap(namedLines)
  assert.deepEqual(found, [], `the names github, jira, gh and acli belong under trackers/:\n${found.join('\n')}`)
  assert.ok(files.length > 40, `only ${files.length} files scanned`)
  assert.ok(files.includes(NAMING_ROOT), `${NAMING_ROOT} is not in the scan`)
  assert.ok(
    files.some(f => inFolder(f, 'hooks')),
    'no file of hooks/ is in the name scan',
  )
  // The allowlist is used, and by one line: a stale pattern or a second naming line fails here.
  const allowed = hits(NAMING_ROOT, TRACKER_NAMES).filter(line => NAMING_LINES[NAMING_ROOT].test(line))
  assert.equal(allowed.length, 1, `${NAMING_ROOT} has ${allowed.length} allowed naming lines`)
})

test('the naming allowlist lets the command text through and nothing else of the composition root', () => {
  const allowed = NAMING_LINES[NAMING_ROOT]
  assert.ok(allowed.test("hooks/register.tsx:184: description: 'Show tracked GitHub, Jira and more',"))
  for (const line of [
    "hooks/register.tsx:26: { gh: idle('gh'), acli: idle('acli') },",
    '// read the transcript, which may call `gh`',
    "hooks/register.tsx:5: const x = 'Show tracked GitHub'",
    "hooks/register.tsx:7: label: 'Show tracked GitHub, Jira',",
    "hooks/other.ts:3: description: 'Show tracked GitHub',",
  ])
    assert.ok(!allowed.test(line), `allowed: ${line}`)
})

test('the names appear under trackers', () => {
  assert.ok(hits('trackers/github/kind.ts', TRACKER_NAMES).length > 0, 'no tracker name in trackers/github/kind.ts')
  assert.ok(hits('trackers/jira/kind.ts', TRACKER_NAMES).length > 0, 'no tracker name in trackers/jira/kind.ts')
})

test('the name pattern is a whole word, in any case', () => {
  for (const line of ['// gh', 'const GitHub = 1', "'jira'", 'run(acli)', 'GH-1', 'a gh b'])
    assert.ok(TRACKER_NAMES.test(line), `missed: ${line}`)
  for (const line of ['ghost', 'enough', 'github2', 'ajira', 'machine', 'a-ghx'])
    assert.ok(!TRACKER_NAMES.test(line), `flagged: ${line}`)
})

// ---------------------------------------------------------------- the quiet mark

/** A line that writes the field `quiet` of a row: `quiet: true`, `quiet,` in an object, `.quiet =`. A comment line does not count. */
const WRITES_QUIET = /(?:\bquiet\s*[:,}]|\.quiet\s*=(?!=))/

/** The `file:line: text` of each code line of `text` (as `file`) that writes the field `quiet`. */
const quietWriters = (file, text) =>
  text
    .split('\n')
    .flatMap((line, i) => (!isComment(line) && WRITES_QUIET.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []))

// `TreeRow.quiet` is the mark of a view (core/lib/grouping.ts): the /track text skips the row, and a group of quiet rows prints
// no title. A tracker that set it on rows of a section with no `text: 'title'` would drop that section from /track with no trace
// (the by-list view prints no title for such a group, and `quietTitles` names only a section with `text: 'title'`).
test('no tracker sets TreeRow.quiet: only a view marks a row', () => {
  const writers = sourcesUnder(['trackers']).flatMap(file => quietWriters(file, textOf(file)))
  assert.deepEqual(writers, [])
})

test('the scan for quiet finds a write in any form and ignores a comment', () => {
  const write = quietWriters(
    'trackers/x/rows.ts',
    ['const a = { id, quiet: true }', 'const b = { ...r, quiet }', 'r.quiet = true', '{ quiet }'].join('\n'),
  )
  assert.equal(write.length, 4)
  assert.deepEqual(
    quietWriters(
      'trackers/x/rows.ts',
      ['// quiet: true', ' * sets quiet: true', 'const quietly = 1', 'const x = r.quiet === true'].join('\n'),
    ),
    [],
  )
  assert.ok(sourcesUnder(['trackers']).includes('trackers/questions/rows.ts'), 'the scan reaches the questions tracker')
})

// ---------------------------------------------------------------- imports

test('the scan sees the whole source tree', () => {
  for (const file of [
    'core/infra/lifecycle.ts',
    'core/interfaces/tracker.ts',
    'core/lib/records.ts',
    'ux/tree-data-table/table.ts',
    'trackers/index.ts',
    'trackers/github/index.ts',
    'hooks/register.tsx',
    'types/index.d.ts',
  ])
    assert.ok(GRAPH.has(file), `${file} is not in the scan`)
  assert.ok(GRAPH.size > 100, `only ${GRAPH.size} files scanned`)
  const edges = [...GRAPH.values()].reduce((n, imports) => n + imports.length, 0)
  assert.ok(edges > 300, `only ${edges} imports found`)
})

test('every relative import of the tree resolves to a file', () => {
  const found = [...GRAPH].flatMap(([file, imports]) =>
    imports.filter(i => isRelative(i.spec) && i.target === null).map(i => `${file}:${i.line}: ${i.spec}`),
  )
  assert.deepEqual(found, [], `an import the contract cannot follow:\n${found.join('\n')}`)
})

test('the parser finds every import: its count is at least the lines with a from, package or relative', () => {
  const miss = []
  for (const file of GRAPH.keys()) {
    const lines = textOf(file)
      .split('\n')
      .filter(l => !isComment(l) && /\bfrom\s*['"]/.test(l)).length
    const found = (GRAPH.get(file) ?? []).length
    if (found < lines) miss.push(`${file}: ${found} parsed, ${lines} lines`)
  }
  assert.deepEqual(miss, [], `the parser missed an import:\n${miss.join('\n')}`)
})

test('importsOf reads every form and ignores comments', () => {
  const text = [
    "import { a } from './a'",
    'import type {',
    '  B,',
    '  type C as D,',
    "} from '../b'",
    "export * from './c'",
    "export { e } from './e'",
    "import './side'",
    "const x = await import('./dyn')",
    "// import { z } from './comment'",
    " * import('./doc')",
    "import pkg from 'claude-code'",
    'import q from "./double"',
    "export const fromThere = 'x'",
    "const note = 'text from ./plain'",
    "declare module 'claude-code' {",
    "  import type { Foo } from 'some-pkg'",
    "\timport './indented-side'",
    '  import type {',
    '    Bar,',
    "  } from '../multi'",
    '}',
  ].join('\n')
  assert.deepEqual(importsOf(text), [
    { spec: './a', line: 1 },
    { spec: '../b', line: 2 },
    { spec: './c', line: 6 },
    { spec: './e', line: 7 },
    { spec: './side', line: 8 },
    { spec: './dyn', line: 9 },
    { spec: 'claude-code', line: 12 },
    { spec: './double', line: 13 },
    { spec: 'some-pkg', line: 17 },
    { spec: './indented-side', line: 18 },
    { spec: '../multi', line: 19 },
  ])
})

test('resolveSpec follows the loader: extensionless, .ts, .tsx, .d.ts, then an index', () => {
  const have = new Set(['core/lib/a.ts', 'ux/b.tsx', 'types/index.d.ts', 'trackers/x/index.ts', 'core/x/c.d.ts'])
  const exists = p => have.has(p)
  assert.equal(resolveSpec('core/infra/m.ts', '../lib/a', exists), 'core/lib/a.ts')
  assert.equal(resolveSpec('core/infra/m.ts', '../../ux/b', exists), 'ux/b.tsx')
  assert.equal(resolveSpec('core/interfaces/m.ts', '../../types', exists), 'types/index.d.ts')
  assert.equal(resolveSpec('trackers/index.ts', './x', exists), 'trackers/x/index.ts')
  assert.equal(resolveSpec('core/infra/m.ts', '../x/c', exists), 'core/x/c.d.ts')
  assert.equal(resolveSpec('core/infra/m.ts', '../lib/missing', exists), null)
})

// A synthetic tree: one clean importer and one that breaks the rule under test.
function tree(files) {
  const have = new Set(Object.keys(files))
  return graphOf(
    Object.keys(files),
    f => files[f],
    p => have.has(p),
  )
}

test('the rules fail on a synthetic breach, naming the file and the line', () => {
  const g = tree({
    'core/interfaces/a.ts': "import type { T } from '../../types'\nimport { l } from '../lib/l'",
    'core/lib/l.ts': "import { i } from '../infra/i'",
    'core/infra/i.ts': "import { t } from '../../trackers/github/index'",
    'ux/u.ts': "import { n } from '../core/infra/i'",
    'ux/table.ts':
      "import { v } from '../hooks/view'\nimport { l } from '../core/lib/l'\nimport { i } from '../core/infra/i'",
    'trackers/github/index.ts': "import { x } from '../jira/index'\nimport { l } from '../../core/lib/l'",
    'trackers/jira/index.ts': '',
    'trackers/index.ts': "import { g } from './github/index'\nimport { k } from './github/kind'",
    'trackers/github/kind.ts': '',
    'hooks/register.tsx': "import { g } from '../trackers/github/index'\nimport { t } from '../trackers'",
    'hooks/events.ts': "import { g } from '../trackers/jira/index'",
    'hooks/view.ts': '',
    'types/index.d.ts':
      "import type { J } from './other'\nimport type { E } from 'claude-code'\ndeclare module 'x' {\n  import type { F } from 'some-pkg'\n}",
    'types/other.d.ts': '',
    'core/extra/x.ts':
      "import { e } from '../../hooks/events'\nimport { b } from '../../ux/u'\nimport { l } from '../lib/l'",
  })
  assert.deepEqual(violations(g, RULES.core), [
    'core/infra/i.ts:1: imports ../../trackers/github/index (trackers/github/index.ts)',
    'core/extra/x.ts:1: imports ../../hooks/events (hooks/events.ts)',
    'core/extra/x.ts:2: imports ../../ux/u (ux/u.ts)',
  ])
  assert.deepEqual(violations(g, RULES.interfaces), ['core/interfaces/a.ts:2: imports ../lib/l (core/lib/l.ts)'])
  assert.deepEqual(violations(g, RULES.lib), ['core/lib/l.ts:1: imports ../infra/i (core/infra/i.ts)'])
  assert.deepEqual(violations(g, RULES.infra), [
    'core/infra/i.ts:1: imports ../../trackers/github/index (trackers/github/index.ts)',
  ])
  assert.deepEqual(violations(g, RULES.ux), [
    'ux/u.ts:1: imports ../core/infra/i (core/infra/i.ts)',
    'ux/table.ts:1: imports ../hooks/view (hooks/view.ts)',
    'ux/table.ts:2: imports ../core/lib/l (core/lib/l.ts)',
    'ux/table.ts:3: imports ../core/infra/i (core/infra/i.ts)',
  ])
  assert.deepEqual(violations(g, RULES.tracker), [
    'trackers/github/index.ts:1: imports ../jira/index (trackers/jira/index.ts)',
  ])
  assert.deepEqual(violations(g, RULES.index), ['trackers/index.ts:2: imports ./github/kind (trackers/github/kind.ts)'])
  assert.deepEqual(violations(g, RULES.outside), [
    'core/infra/i.ts:1: imports ../../trackers/github/index (trackers/github/index.ts)',
    'hooks/register.tsx:1: imports ../trackers/github/index (trackers/github/index.ts)',
    'hooks/events.ts:1: imports ../trackers/jira/index (trackers/jira/index.ts)',
  ])
  assert.deepEqual(violations(g, RULES.register), [
    'hooks/register.tsx:1: imports ../trackers/github/index (trackers/github/index.ts)',
  ])
  assert.deepEqual(violations(g, RULES.types), [
    'types/index.d.ts:1: imports ./other (types/other.d.ts)',
    'types/index.d.ts:2: imports claude-code',
    'types/index.d.ts:4: imports some-pkg',
  ])
})

test('an import the rules cannot follow is a failure, not a pass', () => {
  const g = tree({ 'core/lib/l.ts': "import { x } from './gone'" })
  assert.deepEqual(violations(g, RULES.lib), ['core/lib/l.ts:1: ./gone resolves to no file'])
})

for (const rule of Object.values(RULES)) test(rule.name, () => assertClean(rule))

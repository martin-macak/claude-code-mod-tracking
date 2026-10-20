// Kit test contracts of the plugin (issue #104). The kit stops a test after 5 s, and a busy machine runs a normal wiring
// test past that. A test that drives the engine (a body that takes `$`) takes its `test` from tests/fixtures/kit.ts,
// which gives it a hang guard of 30 s. A test file that takes `test` from 'claude-code/testing' and drives the engine
// brings the 5 s limit back, so this check fails it.
// A ratio check (`expectLinear`) reads CPU time, which node has and the kit has not. Node runs the pure tests only, so a
// kit-only file must ask for the wall clock in each call it makes, or that call would run nowhere.
// Rule: docs/AGENTS.md, "Tests".
// The kit has no fs, so this check runs under node in `make test-scripts`.
// Run: node --test scripts/contracts/kit-test-contracts.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = fileURLToPath(new URL('../../plugins/artifact-tracking/', import.meta.url))
const TESTS = join(PLUGIN, 'tests')

/** The name of a test file: the kit and node run `*.test.ts` and `*.test.tsx`. */
const isTestFile = name => /\.test\.tsx?$/.test(name)

/** Every test file under tests/, as a path relative to the plugin. */
function testFiles() {
  const out = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (isTestFile(entry.name)) out.push(relative(PLUGIN, path))
    }
  }
  walk(TESTS)
  return out.sort()
}

const textOf = file => readFileSync(join(PLUGIN, file), 'utf8')

/** A test body that takes the engine: `async ($, on) => ...` or `($) => ...`. */
const DRIVES_ENGINE = /\(\$[,)]/

/** The names that `text` imports by value from `module`, over every import of it. `import type` and `type X` are left out. */
function valueImports(text, module) {
  const names = []
  const pattern = new RegExp(`^import\\s+([^'"]*?)\\s*from\\s*['"]${module.replace(/[./]/g, '\\$&')}['"]`, 'gm')
  for (const m of text.matchAll(pattern)) {
    if (/^type\b/.test(m[1])) continue
    const clause = /\{([^}]*)\}/.exec(m[1])
    if (!clause) continue
    for (const part of clause[1].split(',')) {
      const name = part.trim()
      if (name && !/^type\b/.test(name)) names.push(name.split(/\s+as\s+/)[0])
    }
  }
  return names
}

const ALL = testFiles()
const ENGINE = ALL.filter(f => DRIVES_ENGINE.test(textOf(f)))

test('the scan sees the whole test folder, the wiring tests included', () => {
  assert.ok(ALL.length > 100, `only ${ALL.length} test files scanned`)
  for (const f of ['tests/register.test.tsx', 'tests/pane.test.tsx', 'tests/lifecycle-wiring.test.tsx'])
    assert.ok(ALL.includes(f), `${f} is not in the scan`)
  assert.ok(ENGINE.length >= 9, `only ${ENGINE.length} files drive the engine: the pattern misses them`)
  assert.ok(ENGINE.includes('tests/register.test.tsx'))
})

test('a test file that drives the engine takes `test` from fixtures/kit, with its hang guard', () => {
  const wrong = ENGINE.filter(f => !valueImports(textOf(f), './fixtures/kit').includes('test'))
  assert.deepEqual(
    wrong,
    [],
    `these files drive the engine (a body that takes $) but take no \`test\` from './fixtures/kit':\n${wrong.join('\n')}`,
  )
})

test('a test file that drives the engine does not take `test` from claude-code/testing', () => {
  const wrong = ENGINE.filter(f => valueImports(textOf(f), 'claude-code/testing').includes('test'))
  assert.deepEqual(
    wrong,
    [],
    `the kit limit of 5 s applies to a \`test\` from 'claude-code/testing'; take it from './fixtures/kit':\n${wrong.join('\n')}`,
  )
})

/** A file that only the kit runs: `.tsx` and `*.kit.test.ts`. Node runs the other test files under `make coverage`. */
const kitOnly = f => /\.tsx$|\.kit\.test\.ts$/.test(f)

/**
 * `text` with its comments and the content of its strings blanked to spaces (the length and the line breaks stay), so a
 * token inside a comment or a string is not read as code. The quotes stay. A `${}` in a template is blanked with the
 * rest of the template: the test files hold no call there.
 */
function blankNonCode(text) {
  const blank = s => s.replace(/[^\n]/g, ' ')
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      out += blank(text.slice(i, stop))
      i = stop
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += blank(text.slice(i, stop))
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      out += c + blank(text.slice(i + 1, j)) + (j < text.length ? c : '')
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

/** The text between the parentheses of each `expectLinear(` call in `code`, which `blankNonCode` has already cleaned. */
function expectLinearCalls(code) {
  const calls = []
  for (const m of code.matchAll(/\bexpectLinear\(/g)) {
    const from = m.index + m[0].length
    let depth = 1
    let i = from
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') depth--
      i++
    }
    calls.push(code.slice(from, i - 1))
  }
  return calls
}

/** The characters of `call` that sit directly in its options object: whatever is nested deeper becomes a space. */
function ownLevel(call) {
  let depth = 0
  let out = ''
  for (const c of call) {
    if ('{[('.includes(c)) {
      depth++
      out += ' '
    } else if ('}])'.includes(c)) {
      depth--
      out += ' '
    } else out += depth === 1 ? c : ' '
  }
  return out
}

/** Does every `expectLinear(` call in `text` ask for the wall clock in its own options? One ask per call, not one per file. */
const askedForWallClockPerCall = text =>
  expectLinearCalls(blankNonCode(text)).every(call => /\bwallClock:\s*true\b/.test(ownLevel(call)))

test('a kit-only file that calls expectLinear asks for the wall clock in each call, so the check runs somewhere', () => {
  const calls = ALL.filter(f => /\bexpectLinear\(/.test(textOf(f)))
  assert.ok(calls.length >= 5, `only ${calls.length} files call expectLinear: the pattern misses them`)
  const wrong = calls.filter(f => kitOnly(f) && !askedForWallClockPerCall(textOf(f)))
  assert.deepEqual(
    wrong,
    [],
    `node has the CPU clock and runs only the pure tests; the kit has none. Each call in a kit-only file needs \`wallClock: true\`:\n${wrong.join('\n')}`,
  )
  assert.ok(
    calls.some(f => !kitOnly(f)),
    'no pure test calls expectLinear: nothing would hold the ratio under node',
  )
})

test('fixtures/kit.ts is the one place that takes `test` from the kit for the wiring tests', () => {
  const kit = 'tests/fixtures/kit.ts'
  assert.ok(valueImports(textOf(kit), 'claude-code/testing').includes('test'))
  assert.match(textOf(kit), /export const HANG_GUARD_MS = 30_000/)
})

test('askedForWallClockPerCall reads the own options of each call, not tokens of the file', () => {
  const call = 'await expectLinear({ wallClock: true, make: k => k, run: () => {} })'
  const bare = 'await expectLinear({ make: k => k, run: () => {} })'
  assert.equal(askedForWallClockPerCall(call), true)
  assert.equal(askedForWallClockPerCall(`${call}\n${call}`), true)
  assert.equal(askedForWallClockPerCall(bare), false)
  // One call asks and the other does not: a count per file would pass this.
  assert.equal(askedForWallClockPerCall(`${call}\n${bare}`), false)
  assert.equal(askedForWallClockPerCall(`${bare}\n${call}`), false)
  // The import is no call. With no call there is nothing to ask.
  assert.equal(askedForWallClockPerCall(`import { expectLinear } from './scaling'\n${call}`), true)
  assert.equal(askedForWallClockPerCall("import { expectLinear } from './scaling'"), true)
  // A token in a comment or a string is no ask, and a call in a comment is no call.
  assert.equal(askedForWallClockPerCall(`${bare}\n// wallClock: true`), false)
  assert.equal(askedForWallClockPerCall(`${bare}\n/* wallClock: true */`), false)
  assert.equal(askedForWallClockPerCall(`${bare}\nconst note = 'wallClock: true'`), false)
  assert.equal(askedForWallClockPerCall(`${bare}\nconst note = \`wallClock: true\``), false)
  assert.equal(askedForWallClockPerCall(`// await expectLinear({ make: k => k })\n${call}`), true)
  assert.equal(askedForWallClockPerCall(`/* await expectLinear({ make: k => k }) */\n${call}`), true)
  // An option of a nested object is not an option of the call.
  assert.equal(
    askedForWallClockPerCall('await expectLinear({ make: k => ({ wallClock: true }), run: () => {} })'),
    false,
  )
  assert.equal(
    askedForWallClockPerCall('await expectLinear({ make: k => k, run: () => ({ wallClock: true }) })'),
    false,
  )
  // A call that asks after nested objects, parens and strings with a bracket in them still asks.
  const long = [
    'await expectLinear({',
    '  label: "a ) in a string",',
    '  make: k => ({ n: k, s: "}" }),',
    '  wallClock: true,',
    "  run: async x => { await f(x, ')') },",
    '})',
  ].join('\n')
  assert.equal(askedForWallClockPerCall(long), true)
  assert.equal(askedForWallClockPerCall(long.replace('wallClock: true', 'wallClock: false')), false)
  // A second `wallClock: true` in one call does not stand for a bare call.
  assert.equal(
    askedForWallClockPerCall(`await expectLinear({ wallClock: true, make: k => k, wallClock: true })\n${bare}`),
    false,
  )
})

test('the scan finds the calls of register.test.tsx, so the check is not empty', () => {
  const calls = expectLinearCalls(blankNonCode(textOf('tests/register.test.tsx')))
  assert.ok(calls.length >= 2, `only ${calls.length} calls found in tests/register.test.tsx`)
})

test('valueImports reads the clause the way the files write it', () => {
  const text = [
    "import type { Engine } from 'claude-code/testing'",
    "import { type On, expect, mock as m } from 'claude-code/testing'",
    "import {\n  test,\n  type Engine as E,\n} from 'claude-code/testing'",
    "import type { test as t } from 'claude-code/testing'",
    "import { test as other } from './fixtures/kit'",
  ].join('\n')
  assert.deepEqual(valueImports(text, 'claude-code/testing'), ['expect', 'mock', 'test'])
  assert.deepEqual(valueImports(text, './fixtures/kit'), ['test'])
  assert.deepEqual(valueImports('', 'claude-code/testing'), [])
})

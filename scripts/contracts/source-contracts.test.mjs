// Source contracts of the plugin (spec 11, "one lifecycle"; plan decision D18). Only hooks/register.tsx may touch the
// engine. It is the one file with a `$` call, an `on(` call, a value import from 'claude-code', the engine type
// `EngineInterface` and the literal state key `plugin: 'artifact-tracking'`.
// The kit has no fs, so this check runs under node in `make test-scripts`.
// Run: node --test scripts/contracts/source-contracts.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = fileURLToPath(new URL('../../plugins/artifact-tracking/', import.meta.url))
const ROOTS = ['core', 'ux', 'trackers', 'hooks', 'types']
const REGISTER = 'hooks/register.tsx'

/** The state key literal, in either quote style. */
const PLUGIN_KEY = /plugin:\s*['"]artifact-tracking['"]/
const ENGINE_TYPE = /\bEngineInterface\b/

/**
 * The ways a source text reaches a value of the engine module: an `import` or `export ... from` that is not type-only,
 * a bare `import 'claude-code'`, and a dynamic `import()` or `require()`. A clause may span lines, and the files have
 * no semicolons, so the clause stops at the first quote. `import type` and `export type` are fine: they erase.
 */
function engineImports(text) {
  const found = []
  for (const m of text.matchAll(/^(?:import|export)\s+([^'"]*?)\s*from\s*['"]claude-code['"]/gm))
    if (!/^type\b/.test(m[1])) found.push(m[0])
  for (const m of text.matchAll(/^import\s+['"]claude-code['"]/gm)) found.push(m[0])
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*['"]claude-code['"]/g)) found.push(m[0])
  return found
}

/** Every `.ts` and `.tsx` file (declaration files too) under the source folders, as a path relative to the plugin. */
function sources() {
  const out = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) out.push(relative(PLUGIN, path))
    }
  }
  for (const root of ROOTS) walk(join(PLUGIN, root))
  return out.sort()
}

const textOf = file => readFileSync(join(PLUGIN, file), 'utf8')

/** The `file:line: text` of each line of `file` that `pattern` matches. */
function hits(file, pattern) {
  return textOf(file)
    .split('\n')
    .flatMap((text, i) => (pattern.test(text) ? [`${file}:${i + 1}: ${text.trim()}`] : []))
}

const ALL = sources()
const OTHERS = ALL.filter(f => f !== REGISTER)

test('the scan sees the whole source tree, register.tsx included', () => {
  assert.ok(ALL.includes(REGISTER), `${REGISTER} is not in the scan`)
  assert.ok(ALL.includes('core/infra/lifecycle.ts'))
  assert.ok(ALL.includes('trackers/index.ts'))
  assert.ok(ALL.includes('types/index.d.ts'))
  assert.ok(OTHERS.length > 50, `only ${OTHERS.length} files scanned`)
})

test('no file but register.tsx matches $. or on(', () => {
  const found = OTHERS.flatMap(f => [...hits(f, /\$\./), ...hits(f, /\bon\(/)])
  assert.deepEqual(found, [], `only ${REGISTER} may touch $ or call on:\n${found.join('\n')}`)
})

test('register.tsx matches both, so an empty scan cannot pass', () => {
  assert.ok(hits(REGISTER, /\$\./).length > 0, 'no $. in register.tsx')
  assert.ok(hits(REGISTER, /\bon\(/).length > 0, 'no on( in register.tsx')
})

test('no file but register.tsx imports a value from claude-code', () => {
  const found = OTHERS.flatMap(f => engineImports(textOf(f)).map(x => `${f}: ${x}`))
  assert.deepEqual(found, [], `a value of the engine module belongs to ${REGISTER} alone:\n${found.join('\n')}`)
  assert.ok(engineImports(textOf(REGISTER)).length > 0, 'no value import in register.tsx')
})

test('the import rule sees every way to reach a value, and lets the type-only forms through', () => {
  const reaching = [
    "import { read, update } from 'claude-code'",
    'import { read } from "claude-code"',
    "import {\n  type EngineInterface,\n  read,\n} from 'claude-code'",
    "import * as engine from 'claude-code'",
    "import engine from 'claude-code'",
    "import typeful from 'claude-code'",
    "export { read } from 'claude-code'",
    "import 'claude-code'",
    "const engine = await import('claude-code')",
    'const engine = require("claude-code")',
    "import { a } from './a'\nimport { read } from 'claude-code'",
  ]
  for (const src of reaching) assert.notDeepEqual(engineImports(src), [], `missed: ${src}`)
  const erased = [
    "import type { Register } from 'claude-code'",
    "import type {\n  A,\n  B,\n} from 'claude-code'",
    "export type { Register } from 'claude-code'",
    "import { read } from './claude-code'",
    "import { read } from 'claude-code/testing'",
    "import { a } from './a'\nimport type { B } from 'claude-code'",
  ]
  for (const src of erased) assert.deepEqual(engineImports(src), [], `flagged: ${src}`)
})

test('no file but register.tsx names EngineInterface', () => {
  const found = OTHERS.flatMap(f => hits(f, ENGINE_TYPE))
  assert.deepEqual(found, [], `a parameter typed with the engine belongs to ${REGISTER} alone:\n${found.join('\n')}`)
  assert.ok(hits(REGISTER, ENGINE_TYPE).length > 0, 'no EngineInterface in register.tsx')
})

test("the text plugin: 'artifact-tracking' appears only in register.tsx, in either quote style", () => {
  const found = OTHERS.flatMap(f => hits(f, PLUGIN_KEY))
  assert.deepEqual(found, [], `state refs are literals in ${REGISTER} only:\n${found.join('\n')}`)
  assert.ok(hits(REGISTER, PLUGIN_KEY).length > 0, 'no state ref in register.tsx')
  for (const src of ["plugin: 'artifact-tracking'", 'plugin: "artifact-tracking"', "plugin:'artifact-tracking'"])
    assert.ok(PLUGIN_KEY.test(src), `missed: ${src}`)
})

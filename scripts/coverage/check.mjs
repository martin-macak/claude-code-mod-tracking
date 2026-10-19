// Fails when a source file of the mod is missing from the coverage report.
// Node reports only the files a test loaded. A module that no pure test loads has no
// row, so a gate on the report alone can look green while that module has no test.
//
// Usage: node scripts/coverage/check.mjs <lcov file> <plugin dir>
//
// Checked: every .ts, .mts, .cts, .js, .mjs and .cjs file under
// <plugin dir>/{core,ux,trackers,hooks}, except
//   - declaration files (*.d.ts) and *.tsx (node cannot load JSX; the kit tests cover them),
//   - core/interfaces/** and trackers/<id>/types.ts (types only, so Node reports no lines for them; Node 24.21
//     leaves such a module out of the report, Node 24.15 lists it with no lines).
// A folder that does not exist is skipped.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOTS = ['core', 'ux', 'trackers', 'hooks']
const TYPE_ONLY = [/^core\/interfaces\//, /^trackers\/[^/]+\/types\.ts$/]
// A source file: .ts, .mts, .cts, .js, .mjs or .cjs. A .tsx file does not match.
const SOURCE = /\.[cm]?[jt]s$/
const DECLARATION = /\.d\.[cm]?ts$/

/** A path relative to `base`, with forward slashes. */
const rel = (base, path) => relative(base, path).split(sep).join('/')

/** Every file below `dir`, relative to `base`. A missing folder gives none. */
function walk(base, dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  return entries.flatMap(e => (e.isDirectory() ? walk(base, join(dir, e.name)) : [rel(base, join(dir, e.name))]))
}

const [lcovPath, pluginArg] = process.argv.slice(2)
if (!lcovPath || !pluginArg) {
  console.error('usage: node check.mjs <lcov file> <plugin dir>')
  process.exit(2)
}
const pluginDir = resolve(pluginArg)

// The `SF:` lines name the loaded files. Resolve them against the plugin dir, so
// an absolute path and a relative one compare equal.
const reported = new Set(
  readFileSync(lcovPath, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.startsWith('SF:'))
    .map(line => rel(pluginDir, resolve(pluginDir, line.slice('SF:'.length).trim()))),
)

const missing = ROOTS.flatMap(root => walk(pluginDir, join(pluginDir, root)))
  .filter(f => SOURCE.test(f) && !DECLARATION.test(f))
  .filter(f => !TYPE_ONLY.some(re => re.test(f)))
  .filter(f => !reported.has(f))
  .sort()

for (const f of missing) console.error(`coverage: no test loads ${f}`)
if (missing.length > 0) {
  console.error(
    `coverage: ${missing.length} source file(s) are missing from the report. Add a pure test that imports each one.`,
  )
  process.exit(1)
}

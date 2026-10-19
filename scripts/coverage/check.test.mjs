// Tests check.mjs through its command line, on small fake plugin folders.
// Run: node --test scripts/coverage/check.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url))

/** Builds a plugin folder with `files`, an lcov report that names `reported`, and runs the check. */
function run(files, reported, { absolute = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cov-check-'))
  try {
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true })
      writeFileSync(join(dir, f), '')
    }
    const lcov = reported.map(f => `SF:${absolute ? join(dir, f) : f}\nend_of_record\n`).join('')
    writeFileSync(join(dir, 'lcov.info'), lcov)
    const r = spawnSync(process.execPath, [CHECK, join(dir, 'lcov.info'), dir], { encoding: 'utf8' })
    return { code: r.status, err: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('passes when every source file is in the report', () => {
  const r = run(
    ['core/lib/a.ts', 'hooks/b.ts', 'trackers/x/c.ts', 'ux/d.ts'],
    ['core/lib/a.ts', 'hooks/b.ts', 'trackers/x/c.ts', 'ux/d.ts'],
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
})

test('names each file that the report lacks and exits 1', () => {
  const r = run(['core/lib/a.ts', 'core/lib/b.ts', 'trackers/x/c.ts'], ['core/lib/a.ts'])
  assert.equal(r.code, 1)
  assert.match(r.err, /no test loads core\/lib\/b\.ts/)
  assert.match(r.err, /no test loads trackers\/x\/c\.ts/)
  assert.doesNotMatch(r.err, /no test loads core\/lib\/a\.ts/)
})

test('skips d.ts, tsx, core/interfaces and files outside the four folders', () => {
  const r = run(
    [
      'hooks/types.d.ts',
      'hooks/register.tsx',
      'ux/pane.tsx',
      'core/interfaces/ports.ts',
      'tests/x.test.ts',
      'scripts/y.ts',
      'hooks/hooks.json',
      'hooks/a.ts',
    ],
    ['hooks/a.ts'],
  )
  assert.equal(r.code, 0, r.err)
})

test('a .mts, .cts, .js, .mjs or .cjs source that the report lacks is named too', () => {
  const r = run(
    ['core/a.mts', 'core/b.cts', 'ux/c.js', 'trackers/x/d.mjs', 'hooks/e.cjs', 'hooks/f.ts'],
    ['hooks/f.ts'],
  )
  assert.equal(r.code, 1)
  for (const f of ['core/a.mts', 'core/b.cts', 'ux/c.js', 'trackers/x/d.mjs', 'hooks/e.cjs']) {
    assert.match(r.err, new RegExp(`no test loads ${f.replace('.', '\\.')}`))
  }
  assert.match(r.err, /5 source file/)
})

test('skips .d.mts and .d.cts declaration files', () => {
  const r = run(['hooks/types.d.mts', 'hooks/types.d.cts', 'hooks/a.ts'], ['hooks/a.ts'])
  assert.equal(r.code, 0, r.err)
})

test('a folder that does not exist is no error', () => {
  const r = run(['hooks/a.ts'], ['hooks/a.ts'])
  assert.equal(r.code, 0, r.err)
})

test('relative SF paths count, also with ./ in front', () => {
  const r = run(['hooks/a.ts', 'core/b.ts'], ['hooks/a.ts', './core/b.ts'], { absolute: false })
  assert.equal(r.code, 0, r.err)
})

test('a report with no file at all fails every source file', () => {
  const r = run(['hooks/a.ts'], [])
  assert.equal(r.code, 1)
  assert.match(r.err, /1 source file/)
})

test('missing arguments exit 2', () => {
  const r = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage/)
})

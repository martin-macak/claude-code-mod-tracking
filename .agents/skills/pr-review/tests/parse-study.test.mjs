import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseStudy, splitRow } from '../scripts/parse-study.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('study with split feasibility tables (#31): items, scores, mechanism and caveat by id', () => {
  const s = parseStudy(fixture('study-31.md'))
  assert.equal(s.kind, 'study')
  assert.equal(s.title, 'Track other repositories that the session visits')
  assert.deepEqual(s.overall, { verdict: 'Go with caveats', mean: 74 })
  assert.equal(s.items.length, 15)
  assert.deepEqual(s.items.map((i) => i.id).slice(0, 3), ['R1', 'R2', 'R3'])
  const r2 = s.items.find((i) => i.id === 'R2')
  assert.equal(r2.name, 'Shell: cd, git -C, gh -R')
  assert.equal(r2.priority, 'Must')
  assert.equal(r2.verdict, 'Partial')
  assert.deepEqual([r2.evidence, r2.ease, r2.safety, r2.score], [5, 3, 3, 60])
  assert.match(r2.text, /^`cd`, `git -C` and `gh -R` in a Bash call add a row/)
  assert.match(r2.mechanism, /^`splitShell`/)
  assert.match(r2.caveat, /^Not seen:/)
  assert.deepEqual(s.warnings, [])
})

test('study with a merged feasibility table (#30): escaped pipes stay in one cell', () => {
  const s = parseStudy(fixture('study-30.md'))
  assert.deepEqual(s.overall, { verdict: 'Go', mean: 76 })
  assert.equal(s.items.length, 12)
  const r1 = s.items.find((i) => i.id === 'R1')
  assert.match(r1.mechanism, /'high' \| 'normal' \| 'low'/)
  assert.equal(r1.caveat, 'None')
  const r8 = s.items.find((i) => i.id === 'R8')
  assert.deepEqual([r8.priority, r8.verdict, r8.score], ['Should', 'Partial', 53])
})

test('design draft (#33) gives kind draft, no items and a warning', () => {
  assert.deepEqual(parseStudy(fixture('draft-33.md')), {
    kind: 'draft',
    items: [],
    warnings: ['Design has no feasibility scores'],
  })
})

test('a study with no score table gives no items and a warning', () => {
  const s = parseStudy('## Design study: X\n\n**Overall: Go** (weighted mean 80/100).\n\nNo tables.\n')
  assert.deepEqual(s.items, [])
  assert.deepEqual(s.warnings, ['No score table found'])
})

test('text with no design throws', () => {
  assert.throws(() => parseStudy('## Something else\n'), /no design study or design draft found/)
})

test('splitRow keeps escaped pipes in the cell', () => {
  assert.deepEqual(splitRow('| R1 | a \\| b | c |'), ['R1', 'a | b', 'c'])
})

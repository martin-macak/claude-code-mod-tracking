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

test('study item ids accept letter suffixes and warn on unreadable rows', () => {
  const s = parseStudy(`## Design study: Demo

**Overall: Go** (weighted mean 78/100).

### 1. Score

| item | priority | verdict | evidence | ease | safety | score |
| --- | --- | --- | --- | --- | --- | --- |
| R2 | Must | Partial | 5 | 3 | 3 | 60 |
| R5a | Must | Go | 4 | 4 | 4 | 85 |
| R5b | Must | Partial | 4 | 3 | 3 | 70 |
| R10 | Should | Go | 3 | 4 | 5 | 80 |
| X1 foo | Should | Go | 3 | 3 | 3 | 75 |

### 3. Feasibility

| item | mechanism | caveat |
| --- | --- | --- |
| R2 | \`splitShell\` | None |
| R5a | \`id\` | None |
| R5b | \`id\` | None |
| R10 | \`id\` | None |
`)
  assert.deepEqual(s.items.map((i) => i.id), ['R2', 'R5a', 'R5b', 'R10'])
  assert.deepEqual(s.warnings, ['Score row skipped: no item id in "X1 foo"'])
})

const SCORE_HEAD =
  '| Rank | Item | Priority | Verdict | Evidence | Ease | Safety | Score |\n| --- | --- | --- | --- | --- | --- | --- | --- |'

// A study with the score tables in section 1 and the rows in section 2.
const study = (score, feasibility = '') => `## Design study: Demo

**Overall: Go** (weighted mean 78/100).

### 1. Score

${score}

### 2. Feasibility per item

${feasibility}

### 3. Spikes
`

test('phase tables (#69, three comments): every phase gives its items, with phase, verdict and score', () => {
  const s = parseStudy(fixture('study-69.md'))
  assert.equal(s.kind, 'study')
  assert.equal(s.title, 'Show what each turn tracked and link items to their turn')
  assert.deepEqual(
    s.items.map((i) => i.id),
    Array.from({ length: 19 }, (_, n) => `R${n + 1}`),
  )
  const p1 = 'Phase 1, PR 1'
  const p1b = 'Phase 1b, PR 2'
  const p2 = 'Phase 2, spike + PR 3'
  assert.deepEqual(
    s.items.map((i) => [i.id, i.phases, i.verdict, i.score]),
    [
      ['R1', [p1], 'Feasible', 84],
      ['R2', [p1], 'Feasible', 86],
      ['R3', [p1], 'Partial', 60],
      ['R4', [p1], 'Heuristic', 42],
      ['R5', [p1], 'Partial', 60],
      ['R6', [p1], 'Feasible', 74],
      ['R7', [p1], 'Partial', 56],
      ['R8', [p1], 'Partial', 65],
      ['R9', [p1], 'Feasible', 90],
      ['R10', [p1], 'Partial', 68],
      ['R11', [p1], 'Partial', 60],
      ['R12', [p1], 'Feasible', 78],
      ['R13', [p1b], 'Untested', 16],
      ['R14', [p2], 'Feasible', 94],
      ['R15', [p2], 'Feasible', 80],
      ['R16', [p2], 'Feasible', 90],
      ['R17', [p2], 'Partial', 63],
      ['R18', [p2], 'Partial', 72],
      ['R19', [p2], 'Feasible', 84],
    ],
  )
  const r13 = s.items.find((i) => i.id === 'R13')
  assert.deepEqual([r13.priority, r13.evidence, r13.ease, r13.safety], ['Should', 2, 3, 4])
  assert.match(r13.text, /^Slot rows/)
  const r19 = s.items.find((i) => i.id === 'R19')
  assert.match(r19.mechanism, /^A scenario in `e2e\/features`/)
  assert.equal(r19.caveat, 'Real model turns: not in CI.')
  assert.deepEqual(s.warnings, [])
})

test('phase tables (#63): labels without the word Phase, an item in two phases, roll-ups in details add no phase', () => {
  const s = parseStudy(fixture('study-63.md'))
  assert.equal(s.items.length, 25)
  const by = (id) => s.items.find((i) => i.id === id)
  assert.deepEqual(by('R1').phases, ['#63 P1 One table (by list)'])
  assert.deepEqual(by('R10').phases, ['#63 P2 Views, keys and filters'])
  const asWritten = '#63 P3 Marks, status area, summary (as written)'
  const recommended = '#63 P3 Marks, status area, summary (recommended: adaptive)'
  assert.deepEqual(by('R12').phases, [asWritten, recommended])
  assert.deepEqual(by('R19').phases, [asWritten, recommended])
  assert.deepEqual(by('R14').phases, [asWritten])
  assert.deepEqual(by('R14r').phases, [recommended])
  assert.deepEqual(by('R7').phases, ['#63 Later (moved out)'])
  assert.deepEqual(
    ['R2b', 'R15', 'R15r', 'R7', 'R20'].map((id) => [id, by(id).verdict, by(id).score]),
    [
      ['R2b', 'Feasible', 70],
      ['R15', 'Partial', 49],
      ['R15r', 'Feasible', 74],
      ['R7', 'Not feasible', 0],
      ['R20', 'Untested', 14],
    ],
  )
  assert.match(by('R12').mechanism, /^Session atom `marks`/)
  assert.deepEqual(s.warnings, [])
})

test('a study with one phase table keeps its result: no phases field on any item', () => {
  for (const name of ['study-30.md', 'study-31.md']) {
    const s = parseStudy(fixture(name))
    assert.ok(s.items.length > 0)
    assert.ok(
      s.items.every((i) => !('phases' in i)),
      name,
    )
  }
})

test('an item with no score or no verdict gives a warning and no fake zero', () => {
  const s = parseStudy(
    study(`${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 |  |
| 2 | R2 Two | Must |  | 5 | 4 | 4 | 90 |
| 3 | R3 Three | Should |  | 5 | 4 | 4 |  |
| 4 | R4 Four | Should | Partial | 4 | 4 | 4 | 60 |`),
  )
  assert.equal(s.items.find((i) => i.id === 'R1').score, null)
  assert.equal(s.items.find((i) => i.id === 'R2').verdict, '')
  assert.deepEqual(s.warnings, ['R1: no score', 'R2: no verdict', 'R3: no verdict and no score'])
})

test('an item that only a section 2 row names gives a warning, with its text, priority and mechanism', () => {
  const s = parseStudy(
    study(
      `${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 | 90 |`,
      `| Item | Pri | Verdict | Mechanism | Caveat | Evidence |
| --- | --- | --- | --- | --- | --- |
| R1 One | Must | Feasible | m1 | None | [observed] |
| R9 Nine, in full | Should | Partial | m9 | c9 | [observed] |`,
    ),
  )
  assert.deepEqual(
    s.items.map((i) => i.id),
    ['R1', 'R9'],
  )
  const r9 = s.items[1]
  assert.deepEqual(
    [r9.text, r9.priority, r9.verdict, r9.score, r9.mechanism, r9.caveat],
    ['Nine, in full', 'Should', '', null, 'm9', 'c9'],
  )
  assert.deepEqual(s.warnings, ['R9: in section 2 but in no score table, so no verdict and no score'])
})

test('an item in two phase tables keeps both phases; a later table fills a blank; a disagreement warns', () => {
  const s = parseStudy(
    study(`**Phase 1**

${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 | 90 |
| 2 | R2 Two | Must | Partial | 4 | 3 | 3 |  |
| 3 | R3 Three | Should | Partial | 4 | 3 | 3 | 60 |

**Overall: Go** (mean >= 75). Weighted mean: 80/100.

**Phase 2**

${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 | 90 |
| 2 | R2 Two | Must | Partial | 4 | 3 | 3 | 65 |
| 3 | R3 Three | Should | Feasible | 5 | 4 | 4 | 90 |`),
  )
  assert.deepEqual(
    s.items.map((i) => [i.id, i.phases]),
    [
      ['R1', ['Phase 1', 'Phase 2']],
      ['R2', ['Phase 1', 'Phase 2']],
      ['R3', ['Phase 1', 'Phase 2']],
    ],
  )
  assert.equal(s.items[1].score, 65)
  assert.deepEqual([s.items[2].verdict, s.items[2].score], ['Partial', 60])
  assert.deepEqual(s.warnings, ['R3: phases disagree ("Phase 1": Partial 60, "Phase 2": Feasible 90). Kept the first.'])
})

test('a score table in details is a roll-up: it adds no phase to a known item, but a new item stays', () => {
  const s = parseStudy(
    study(`**Phase 1**

${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 | 90 |

**Phase 2**

${SCORE_HEAD}
| 1 | R2 Two | Must | Partial | 4 | 3 | 3 | 60 |

<details><summary>All phases</summary>

**All phases together**

${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 | 90 |
| 2 | R2 Two | Must | Partial | 4 | 3 | 3 | 61 |
| 3 | R3 Three | Could | Feasible | 5 | 4 | 4 | 90 |

</details>`),
  )
  assert.deepEqual(
    s.items.map((i) => [i.id, i.phases, i.score]),
    [
      ['R1', ['Phase 1'], 90],
      ['R2', ['Phase 2'], 60],
      ['R3', ['All phases together'], 90],
    ],
  )
  assert.deepEqual(s.warnings, [])
})

test('a roll-up in details before the phase tables adds no phase and gives no score', () => {
  const s = parseStudy(
    study(`<details><summary>All phases</summary>

**All phases together**

${SCORE_HEAD}
| 1 | R1 One | Must | Partial | 4 | 3 | 3 | 50 |
| 2 | R2 Two | Must | Partial | 4 | 3 | 3 | 61 |
| 3 | R3 Three | Could | Feasible | 5 | 4 | 4 | 90 |

</details>

**Phase 1**

${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 | 90 |

**Phase 2**

${SCORE_HEAD}
| 1 | R2 Two | Must | Partial | 4 | 3 | 3 | 60 |`),
  )
  assert.deepEqual(
    s.items.map((i) => [i.id, i.phases, i.verdict, i.score]),
    [
      ['R1', ['Phase 1'], 'Feasible', 90],
      ['R2', ['Phase 2'], 'Partial', 60],
      ['R3', ['All phases together'], 'Feasible', 90],
    ],
  )
  assert.deepEqual(s.warnings, [])
})

test('a table with no bold label before it gets a numbered phase name when the study has several', () => {
  const s = parseStudy(
    study(`${SCORE_HEAD}
| 1 | R1 One | Must | Feasible | 5 | 4 | 4 | 90 |

**Later**

${SCORE_HEAD}
| 1 | R2 Two | Could | Untested | 2 | 2 | 4 | 14 |`),
  )
  assert.deepEqual(
    s.items.map((i) => [i.id, i.phases]),
    [
      ['R1', ['Score table 1']],
      ['R2', ['Later']],
    ],
  )
})

test('splitRow keeps escaped pipes in the cell', () => {
  assert.deepEqual(splitRow('| R1 | a \\| b | c |'), ['R1', 'a | b', 'c'])
})

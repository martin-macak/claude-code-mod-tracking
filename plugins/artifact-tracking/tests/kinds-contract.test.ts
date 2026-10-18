// The contract of an item kind: a kind with only the required members must fit `ItemKind` and join a `Tracker`.
// The `satisfies` checks run in `tsc` (the node loader strips types), so a contract that asks for more breaks `make test`.
// Plan: L5 Task 1 (K3, K4, K5, K24).
import { expect, test } from 'claude-code/testing'
import type { Claim, ItemKind } from '../core/interfaces/items'
import type { Tracker } from '../core/interfaces/tracker'
import { bool, type Schema, specOf } from '../core/lib/normalise'
import * as artifactTypes from '../trackers/artifact/types'
import * as autoTypes from '../trackers/auto/types'
import * as fileTypes from '../trackers/file/types'
import * as githubTypes from '../trackers/github/types'
import * as jiraTypes from '../trackers/jira/types'
import * as processesTypes from '../trackers/processes/types'
import * as reposTypes from '../trackers/repos/types'
import * as webTypes from '../trackers/web/types'

test('a kind with only decode and merge fits ItemKind and joins a Tracker', () => {
  const k = {
    category: 'note',
    rank: 50,
    decode: i => (i.category === 'note' ? i : null),
    merge: (cur, seen) =>
      cur ?? { key: seen.key, category: 'note', sources: [seen.source], firstSeen: seen.at, lastSeen: seen.at },
  } satisfies ItemKind
  const config = specOf({ enabled: bool(true) } as const satisfies Schema)
  const t = {
    id: 'notes',
    order: 99,
    config,
    kinds: [k],
    tools: [{ id: 'notes-cli', probe: ['notes-cli', '--version'] }],
    init: () => {},
    store: c => c.config.slice(),
  } satisfies Tracker
  expect([k].map(x => x.rank)).toEqual([50])
  expect(t.kinds.map(x => x.category)).toEqual(['note'])
})

test('a Claim carries the fields of a ref', () => {
  const c: Claim = {
    category: 'github',
    key: 'gh:github.com/o/r#5',
    source: 'prompt',
    at: 1,
    fields: { host: 'github.com', owner: 'o', repo: 'r', number: 5, type: 'issue' },
  }
  expect(c.fields.number).toBe(5)
})

// The node coverage gate wants every source file loaded by a test (`check.mjs`), but it skips `trackers/<id>/types.ts`:
// these modules hold types only, and Node 24.21 leaves such a module out of the report. This test loads them anyway and
// pins that no runtime value hides in a file the contract calls type-only. `core/lib/records.ts`
// held the record types only until plan Task 4; it holds the record algebra now and `records.test.ts` loads it.
// Node reads a module with no `type` field as CommonJS and adds `default` and `module.exports` to its namespace.
const valuesOf = (m: object): string[] => Object.keys(m).filter(k => k !== 'default' && k !== 'module.exports')

test('the tracker type modules load and export no value', () => {
  const modules = {
    artifactTypes,
    autoTypes,
    fileTypes,
    githubTypes,
    jiraTypes,
    processesTypes,
    reposTypes,
    webTypes,
  }
  expect(Object.fromEntries(Object.entries(modules).map(([name, m]) => [name, valuesOf(m)]))).toEqual({
    artifactTypes: [],
    autoTypes: [],
    fileTypes: [],
    githubTypes: [],
    jiraTypes: [],
    processesTypes: [],
    reposTypes: [],
    webTypes: [],
  })
})

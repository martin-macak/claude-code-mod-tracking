// The contract of an item kind: a kind with only the required members must fit `ItemKind` and join a `Tracker`.
// The `satisfies` checks run in `tsc` (the node loader strips types), so a contract that asks for more breaks `make test`.
// Plan: L5 Task 1 (K3, K4, K5, K24).
import { expect, test } from 'claude-code/testing'
import type { Claim, ItemKind } from '../core/interfaces/items'
import type { Tracker } from '../core/interfaces/tracker'
import { bool, type Schema, specOf } from '../core/lib/normalise'
import { reasonSet } from '../core/lib/reasons'
import * as artifactTypes from '../trackers/artifact/types'
import * as autoTypes from '../trackers/auto/types'
import * as fileTypes from '../trackers/file/types'
import * as githubTypes from '../trackers/github/types'
import * as jiraTypes from '../trackers/jira/types'
import * as processesTypes from '../trackers/processes/types'
import * as reposTypes from '../trackers/repos/types'
import * as webTypes from '../trackers/web/types'

// `row` is required since plan L5 Task 13 (K24): the kind builds its own pane row.
test('a kind with only decode and merge fits ItemKind and joins a Tracker', () => {
  const k = {
    category: 'note',
    rank: 50,
    decode: i => (i.category === 'note' ? i : null),
    merge: (cur, seen) =>
      cur ?? {
        key: seen.key,
        category: 'note',
        sources: [seen.source],
        reasons: reasonSet(seen.reason),
        firstSeen: seen.at,
        lastSeen: seen.at,
      },
    row: i => ({ id: i.key, owner: 'notes', cells: {} }),
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
    reason: 'mentioned',
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

// ---------------------------------------------------------------- reasons are required (issue #62)

test('a Claim must carry a reason, and a StoredItem must carry its reasons: the type check fails without them', () => {
  // @ts-expect-error a claim with no `reason` does not compile
  const noReason: Claim = { category: 'github', key: 'k', source: 'prompt', at: 1, fields: {} }
  // @ts-expect-error a claim whose reason is not a core reason does not compile
  const badReason: Claim = { category: 'github', key: 'k', source: 'prompt', reason: 'seen', at: 1, fields: {} }
  // @ts-expect-error a record with no `reasons` does not compile
  const noReasons: StoredItem = { key: 'k', category: 'x', sources: [], firstSeen: 1, lastSeen: 1 }
  // @ts-expect-error a record whose reasons hold a word that is not a core reason does not compile
  const badReasons: StoredItem = {
    key: 'k',
    category: 'x',
    sources: [],
    reasons: { first: 'seen', all: ['seen'], strongest: 'seen' },
    firstSeen: 1,
    lastSeen: 1,
  }
  expect([noReason, badReason, noReasons, badReasons]).toHaveLength(4)
})

test('a kind that adds a reason maps it to a core reason: `ItemKind.reasons` takes `{ id, core }` and nothing else', () => {
  const k = {
    category: 'note',
    rank: 50,
    reasons: [{ id: 'reviewed', core: 'read' }],
    decode: i => (i.category === 'note' ? i : null),
    merge: cur => cur,
    row: i => ({ id: i.key, owner: 'notes', cells: {} }),
  } satisfies ItemKind
  expect(k.reasons).toEqual([{ id: 'reviewed', core: 'read' }])
  // @ts-expect-error a kind reason must map to a core reason
  const unmapped: ItemKind['reasons'] = [{ id: 'reviewed', core: 'seen' }]
  expect(unmapped).toHaveLength(1)
})

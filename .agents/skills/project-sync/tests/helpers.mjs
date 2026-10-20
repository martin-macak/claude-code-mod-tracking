// Support for the tests: builders for the inputs of plan() (project items and the issue graph), the
// snapshot of the live project, and the fakes of what GitHub does. No network.
import { readFileSync } from 'node:fs'
import { normalizeProject } from '../scripts/core.mjs'

export const REPO = 'martin-macak/claude-code-mod-tracking'
export const OPTIONS = {
  Status: ['Blocked', 'Ready', 'In progress', 'In review', 'Done'],
  Wave: ['Wave 0', 'Wave 1', 'Wave 2', 'Wave 3'],
}
export const NONE = '—'

// The key of an issue: a number is an issue of REPO, a string is a full key already.
export const keyOf = ref => (typeof ref === 'number' ? `${REPO}#${ref}` : ref)

function fieldsOf(o) {
  return {
    Status: o.status ?? null,
    Wave: o.wave ?? null,
    Order: o.order ?? null,
    Release: o.release ?? null,
    Area: o.area ?? null,
    'Blocked by': o.text ?? null,
  }
}

// project().issue(1).issue(2, { blockedBy: [1] }).build() gives { items, graph }.
// A number is an issue of REPO. A string is a full key, "owner/repo#N".
export function project() {
  const items = []
  const graph = {}
  const b = {
    // An issue in the project. It is in the graph too.
    issue(number, o = {}) {
      const key = keyOf(number)
      const state = o.state ?? 'OPEN'
      graph[key] = { key, id: `I_${number}`, repo: REPO, number, state, blockedBy: (o.blockedBy ?? []).map(keyOf) }
      items.push({
        id: `PVTI_${number}`,
        kind: 'issue',
        key,
        repo: REPO,
        number,
        title: o.title ?? `Issue ${number}`,
        state,
        milestone: o.milestone ?? null,
        fields: fieldsOf(o),
      })
      return b
    },
    // An issue that is not in the project. It is only in the graph.
    external(ref, o = {}) {
      const key = keyOf(ref)
      const [repo, number] = key.split('#')
      graph[key] = {
        key,
        id: `I_${key}`,
        repo,
        number: Number(number),
        state: o.state ?? 'OPEN',
        blockedBy: (o.blockedBy ?? []).map(keyOf),
      }
      return b
    },
    pr(number, o = {}) {
      items.push({
        id: `PVTI_pr${number}`,
        kind: 'pr',
        key: keyOf(number),
        repo: REPO,
        number,
        title: o.title ?? `PR ${number}`,
        state: o.state ?? 'OPEN',
        milestone: null,
        fields: fieldsOf(o),
      })
      return b
    },
    draft(title, o = {}) {
      items.push({
        id: `PVTI_${title}`,
        kind: 'draft',
        key: null,
        repo: null,
        number: null,
        title,
        state: null,
        milestone: null,
        fields: fieldsOf(o),
      })
      return b
    },
    build: () => ({ items, graph }),
  }
  return b
}

// The live project on 2026-10-18, as `gh api graphql` returned it (query: ProjectItems), and the
// same after normalizeProject. Tests that change the snapshot work on a copy.
export const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/live-project-2026-10-18.json', import.meta.url), 'utf8'),
)
export const live = normalizeProject(snapshot.data.repositoryOwner.projectV2)

// What GitHub does with updateProjectV2ItemPosition: it takes the entry out and puts it after
// afterId (null: first). `idOf` reads the id of an entry. Returns the new list. An id that the list
// does not hold (GitHub lists a new item late) moves nothing: the move still lands, on an item that
// the list does not show. That is an assumption about GitHub. No live run of add --apply has shown
// it yet (PR #114).
export function moveAfter(list, id, afterId, idOf = x => x) {
  const out = [...list]
  const from = out.findIndex(x => idOf(x) === id)
  if (from < 0) return out
  const [moved] = out.splice(from, 1)
  out.splice(afterId === null ? 0 : out.findIndex(x => idOf(x) === afterId) + 1, 0, moved)
  return out
}

// One Issue node as GraphQL answers it. A blocker is a number (OPEN) or [number, state].
export const issueNode = (number, { id = `I_${number}`, state = 'OPEN', blockers = [], repo = REPO } = {}) => ({
  __typename: 'Issue',
  id,
  number,
  state,
  repository: { nameWithOwner: repo },
  blockedBy: {
    pageInfo: { hasNextPage: false },
    nodes: blockers.map(b => {
      const [n, s = 'OPEN'] = [b].flat()
      return { id: `I_${n}`, number: n, state: s, repository: { nameWithOwner: repo } }
    }),
  },
})

// A graph node whose blockers are not loaded yet: what normalizeProject adds for an outside blocker.
export const stubNode = (number, { state = 'OPEN', repo = REPO } = {}) => ({
  key: `${repo}#${number}`,
  id: `I_${number}`,
  repo,
  number,
  state,
  blockedBy: null,
})

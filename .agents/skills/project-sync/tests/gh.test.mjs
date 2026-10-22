import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PlanError } from '../scripts/core.mjs'
import {
  addToProject,
  applyChanges,
  applyMoves,
  classifyFailure,
  GhError,
  issueNodes,
  itemEditArgs,
  loadBlockers,
  makeGh,
  READ_ATTEMPTS,
  READ_BACKOFF_MS,
  readComplete,
  readMilestoneIssues,
  readProject,
  resolveContent,
  sleepSync,
} from '../scripts/gh.mjs'
import { issueNode, keyOf as key, live, livePages, REPO, snapshot, stubNode } from './helpers.mjs'

// A runner that records the calls and answers with canned replies.
function fakeRunner(answer) {
  const calls = []
  const runner = (args, input) => {
    const body = input ? JSON.parse(input) : null
    calls.push({ args, body })
    return answer(args, body, calls.length)
  }
  runner.calls = calls
  return runner
}
const ok = value => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
const fail = (status, stderr, stdout = '') => ({ status, stdout, stderr })

// Strings that gh printed in real runs, and the one that GitHub documents for a missing scope.
const SCOPE_BODY = JSON.stringify({
  errors: [
    {
      type: 'INSUFFICIENT_SCOPES',
      message:
        "Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes.",
    },
  ],
})

test('classifyFailure: authentication and scope failures are auth, the rest is other', () => {
  const auth = [
    fail(1, 'gh: Bad credentials (HTTP 401)'),
    fail(
      4,
      'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable',
    ),
    fail(1, 'gh: Your token has not been granted the required scopes to execute this query.', SCOPE_BODY),
    fail(1, 'gh: Resource not accessible by personal access token (HTTP 403)'),
    fail(1, 'gh: Requires authentication (HTTP 401)'),
    fail(4, ''),
  ]
  for (const f of auth) assert.equal(classifyFailure(f), 'auth', JSON.stringify(f))
  const other = [
    fail(1, "gh: Field 'nope' doesn't exist on type 'User'"),
    fail(1, 'gh: API rate limit exceeded for user ID 1. (HTTP 403)'),
    fail(1, 'gh: Server Error (HTTP 502)'),
    fail(1, 'gh: Could not resolve to an Issue with the number of 99999. (HTTP 404)'),
  ]
  for (const f of other) assert.equal(classifyFailure(f), 'other', JSON.stringify(f))
})

test('graphql posts the query and the variables as one JSON body on stdin, and returns data', () => {
  const runner = fakeRunner(() => ok({ data: { viewer: { login: 'x' } } }))
  const data = makeGh(runner).graphql('query Q($a: Int) { x }', { a: 1 })
  assert.deepEqual(data, { viewer: { login: 'x' } })
  assert.deepEqual(runner.calls[0].args, ['api', 'graphql', '--input', '-'])
  assert.deepEqual(runner.calls[0].body, { query: 'query Q($a: Int) { x }', variables: { a: 1 } })
})

test('graphql throws a GhError of kind auth on a bad token, with the first line of gh', () => {
  const gh = makeGh(fakeRunner(() => fail(1, 'gh: Bad credentials (HTTP 401)\n')))
  assert.throws(
    () => gh.graphql('query { x }', {}),
    err => err instanceof GhError && err.kind === 'auth' && err.message === 'gh: Bad credentials (HTTP 401)',
  )
})

// A guard, not an observed shape: gh exits 1 when the body has errors (see the tests below).
test('graphql also throws on a body with errors when gh exits 0', () => {
  const gh = makeGh(fakeRunner(() => ok(SCOPE_BODY)))
  assert.throws(
    () => gh.graphql('query { x }', {}),
    err => err.kind === 'auth' && /required scopes/.test(err.message),
  )
  const other = makeGh(fakeRunner(() => ok({ errors: [{ message: 'boom' }] })))
  assert.throws(
    () => other.graphql('query { x }', {}),
    err => err.kind === 'other' && err.message === 'boom',
  )
})

test('a missing gh binary is a GhError of kind missing', () => {
  const gh = makeGh(() => ({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
  }))
  assert.throws(
    () => gh.exec(['auth', 'status']),
    err => err.kind === 'missing' && /gh is not installed/.test(err.message),
  )
})

// gh can exit before it reads its stdin. spawnSync then reports EPIPE and still gives the status and
// the streams, so the run is finished and its status and stderr classify it.
test('graphql: EPIPE with a status is a finished run, and its stderr says it is an auth failure', () => {
  const gh = makeGh(() => ({ error: { code: 'EPIPE' }, status: 1, stderr: 'gh: Bad credentials (HTTP 401)' }))
  assert.throws(
    () => gh.graphql('query { x }', {}),
    err => err instanceof GhError && err.kind === 'auth' && err.message === 'gh: Bad credentials (HTTP 401)',
  )
})

test('exec: EPIPE without a status, and other spawn errors, still fail to start', () => {
  const killed = makeGh(() => ({ error: { code: 'EPIPE', message: 'write EPIPE' }, status: null, stderr: '' }))
  assert.throws(
    () => killed.exec(['auth', 'status']),
    err => err instanceof GhError && err.kind === 'other' && err.message === 'gh failed to start: write EPIPE',
  )
  // Only a failed run counts as finished. EPIPE with status 0 means gh did not read the whole query,
  // so its reply does not answer that query.
  const partial = makeGh(() => ({ error: { code: 'EPIPE', message: 'write EPIPE' }, status: 0, stdout: '{}', stderr: '' }))
  assert.throws(
    () => partial.exec(['auth', 'status']),
    err => err instanceof GhError && err.kind === 'other' && err.message === 'gh failed to start: write EPIPE',
  )
  const denied = makeGh(() => ({ error: { code: 'EACCES', message: 'spawn gh EACCES' }, status: null, stderr: '' }))
  assert.throws(
    () => denied.exec(['auth', 'status']),
    err => err instanceof GhError && err.kind === 'other' && err.message === 'gh failed to start: spawn gh EACCES',
  )
})

// A real spawnSync, not a fake runner. A query larger than the pipe buffer makes the write fail with
// EPIPE every time when gh exits first, so the test does not depend on a race.
test('real runner: a gh that exits before it reads a large query is an auth failure, not a failed start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'project-sync-'))
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "gh: Bad credentials (HTTP 401)" >&2\nexit 1\n')
  chmodSync(join(dir, 'gh'), 0o755)
  const saved = process.env.PATH
  process.env.PATH = dir
  try {
    assert.throws(
      () => makeGh().graphql(`query { ${'x'.repeat(1 << 20)} }`, {}),
      err => err instanceof GhError && err.kind === 'auth' && err.message === 'gh: Bad credentials (HTTP 401)',
    )
  } finally {
    process.env.PATH = saved
  }
})

test('rest reads JSON from gh api', () => {
  const runner = fakeRunner(() => ok({ html_url: 'u' }))
  assert.deepEqual(makeGh(runner).rest('repos/o/r/issues/1'), { html_url: 'u' })
  assert.deepEqual(runner.calls[0].args, ['api', 'repos/o/r/issues/1'])
})

// One reply of the project query: the nodes of one page, as the items connection gives them.
// totalCount: what GitHub counts, as many as the nodes unless a test says otherwise.
const ALL_NODES = snapshot.data.repositoryOwner.projectV2.items.nodes
const projectPage = (nodes, { more = false, cursor = null, total = nodes.length } = {}) => ({
  data: {
    repositoryOwner: {
      projectV2: {
        ...snapshot.data.repositoryOwner.projectV2,
        items: { totalCount: total, pageInfo: { hasNextPage: more, endCursor: cursor }, nodes },
      },
    },
  },
})

test('readProject reads every page and merges the items', () => {
  const [first, second] = [ALL_NODES.slice(0, 10), ALL_NODES.slice(10)]
  const runner = fakeRunner((_args, body) =>
    ok(
      body.variables.cursor
        ? projectPage(second, { total: 23 })
        : projectPage(first, { more: true, cursor: 'C1', total: 23 }),
    ),
  )
  const read = readProject(makeGh(runner), { owner: 'martin-macak', number: 3 })
  assert.equal(read.items.length, 23)
  assert.equal(runner.calls.length, 2)
  assert.deepEqual(
    runner.calls.map(c => c.body.variables),
    [
      { owner: 'martin-macak', number: 3, cursor: null },
      { owner: 'martin-macak', number: 3, cursor: 'C1' },
    ],
  )
  assert.match(runner.calls[0].body.query, /first: 100/)
  assert.deepEqual(read.project, live.project)
  // Each page gives its totalCount. readProblems compares them with the items that were listed.
  assert.deepEqual(read.totalCounts, [23, 23])
})

test('the project query asks for the item count, and readProject keeps a page that gives none', () => {
  const runner = fakeRunner(() => {
    const reply = projectPage(ALL_NODES)
    delete reply.data.repositoryOwner.projectV2.items.totalCount
    return ok(reply)
  })
  const read = readProject(makeGh(runner), { owner: 'martin-macak', number: 3 })
  assert.match(runner.calls[0].body.query, /items\(first: 100[^)]*\) \{\s+totalCount\s+pageInfo/)
  assert.deepEqual(read.totalCounts, [null])
})

test('readProject drops the null nodes of a partial answer, so the count shows them missing', () => {
  const runner = fakeRunner(() => ok(projectPage([ALL_NODES[0], null, ALL_NODES[1]], { total: 3 })))
  const read = readProject(makeGh(runner), { owner: 'martin-macak', number: 3 })
  assert.equal(read.items.length, 2)
  assert.deepEqual(read.totalCounts, [3])
})

test('readProject: an owner that GitHub does not return is an auth failure with a clear message', () => {
  // gh on 2026-10-18, owner that does not exist: exit 0 and {"data":{"repositoryOwner":null}}.
  const gh = makeGh(fakeRunner(() => ok({ data: { repositoryOwner: null } })))
  assert.throws(
    () => readProject(gh, { owner: 'martin-macak', number: 9 }),
    err => err.kind === 'auth' && /project 9 of martin-macak/i.test(err.message),
  )
})

test('readProject: a project number that does not exist makes gh exit 1, and the failure is kind other', () => {
  // gh on 2026-10-18, project 9999 of a known owner: exit 1, the message on stderr and this body on stdout.
  const body = {
    data: { repositoryOwner: { projectV2: null } },
    errors: [
      {
        type: 'NOT_FOUND',
        path: ['repositoryOwner', 'projectV2'],
        locations: [{ line: 1, column: 111 }],
        message: 'Could not resolve to a ProjectV2 with the number 9999.',
      },
    ],
  }
  const gh = makeGh(
    fakeRunner(() => fail(1, 'gh: Could not resolve to a ProjectV2 with the number 9999.\n', JSON.stringify(body))),
  )
  assert.throws(
    () => readProject(gh, { owner: 'martin-macak', number: 9999 }),
    err =>
      err instanceof GhError &&
      err.kind === 'other' &&
      err.message === 'gh: Could not resolve to a ProjectV2 with the number 9999.',
  )
})

test('loadBlockers follows the blockers of blockers until the graph is closed', () => {
  const graph = { [key(70)]: stubNode(70) }
  const tree = { 70: [71], 71: [72], 72: [] }
  const runner = fakeRunner((_args, body) =>
    ok({
      data: { nodes: body.variables.ids.map(id => issueNode(Number(id.slice(2)), { blockers: tree[id.slice(2)] })) },
    }),
  )
  const warnings = loadBlockers(makeGh(runner), graph)
  assert.deepEqual(warnings, [])
  assert.deepEqual(graph[key(70)].blockedBy, [key(71)])
  assert.deepEqual(graph[key(72)].blockedBy, [])
  assert.deepEqual(
    runner.calls.map(c => c.body.variables.ids),
    [['I_70'], ['I_71'], ['I_72']],
  )
})

test('loadBlockers asks for at most 50 ids in one call', () => {
  const graph = {}
  for (let n = 1; n <= 120; n += 1) graph[key(n)] = stubNode(n)
  const runner = fakeRunner((_args, body) =>
    ok({ data: { nodes: body.variables.ids.map(id => issueNode(Number(id.slice(2)))) } }),
  )
  loadBlockers(makeGh(runner), graph)
  assert.deepEqual(
    runner.calls.map(c => c.body.variables.ids.length),
    [50, 50, 20],
  )
})

test('loadBlockers makes no call when every blocker is known', () => {
  const runner = fakeRunner(() => assert.fail('no call expected'))
  assert.deepEqual(loadBlockers(makeGh(runner), live.graph), [])
  assert.equal(runner.calls.length, 0)
})

// gh on 2026-10-18, ids that GitHub cannot resolve: exit 1, a message on stderr, and a body that
// still holds data.nodes, with null for each id that failed. `known` maps node ids to nodes.
const notFound = (index, id) => ({
  type: 'NOT_FOUND',
  path: ['nodes', index],
  locations: [{ line: 1, column: 2 }],
  message: `Could not resolve to a node with the global id of '${id}'`,
})
const issuesRunner = known =>
  fakeRunner((_args, body) => {
    const ids = body.variables.ids
    const nodes = ids.map(id => known[id] ?? null)
    const failed = ids.flatMap((id, i) => (known[id] ? [] : [[i, id]]))
    if (failed.length === 0) return ok({ data: { nodes } })
    const errors = failed.map(([i, id]) => notFound(i, id))
    return fail(1, `gh: ${errors[0].message}\n`, JSON.stringify({ data: { nodes }, errors }))
  })

test('loadBlockers warns about an issue that GitHub cannot resolve, and goes on', () => {
  const graph = { [key(70)]: stubNode(70) }
  const warnings = loadBlockers(makeGh(issuesRunner({})), graph)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /#70 could not be read/)
  assert.deepEqual(graph[key(70)].blockedBy, [])
})

test('loadBlockers keeps the issues that GitHub resolved, next to one that it cannot', () => {
  const graph = { [key(70)]: stubNode(70), [key(71)]: stubNode(71) }
  const runner = issuesRunner({ I_70: issueNode(70, { blockers: [72] }), I_72: issueNode(72) })
  const warnings = loadBlockers(makeGh(runner), graph)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /#71 could not be read/)
  assert.deepEqual(graph[key(70)].blockedBy, [key(72)])
  assert.deepEqual(graph[key(72)].blockedBy, [])
  assert.deepEqual(graph[key(71)].blockedBy, [])
})

test('issueNodes also reads the nodes of a NOT_FOUND body when gh exits 0 (a guard: gh exits 1 today)', () => {
  const body = { data: { nodes: [null] }, errors: [notFound(0, 'I_70')] }
  assert.deepEqual(issueNodes(makeGh(fakeRunner(() => ok(body))), ['I_70']), [null])
})

test('issueNodes does not hide an error that is not a NOT_FOUND', () => {
  const mixed = { data: { nodes: [null] }, errors: [notFound(0, 'I_70'), { type: 'FORBIDDEN', message: 'no' }] }
  const replies = [
    fail(1, 'gh: Bad credentials (HTTP 401)'),
    fail(1, 'gh: Your token has not been granted the required scopes to execute this query.', SCOPE_BODY),
    fail(1, 'gh: no', JSON.stringify(mixed)),
    fail(1, 'gh: Server Error (HTTP 502)', '<html>bad gateway</html>'),
  ]
  for (const reply of replies) {
    assert.throws(() => issueNodes(makeGh(fakeRunner(() => reply)), ['I_70']), GhError, reply.stderr)
  }
})

const milestonePage = (nodes, hasNextPage = false, endCursor = null) => ({
  data: { repository: { milestones: { pageInfo: { hasNextPage, endCursor }, nodes } } },
})
const milestone = (number, title, issues, more = null) => ({
  number,
  title,
  issues: {
    pageInfo: { hasNextPage: more !== null, endCursor: more },
    nodes: issues.map(n => ({ number: n, title: `Issue ${n}` })),
  },
})

test('readMilestoneIssues reads the open issues of every open milestone of the repo', () => {
  const runner = fakeRunner(() =>
    ok(milestonePage([milestone(1, 'artifact-tracking 0.2.0', [55, 62]), milestone(2, 'other 0.3.0', [90])])),
  )
  const out = readMilestoneIssues(makeGh(runner), { repo: REPO })
  assert.deepEqual(out, [
    { key: key(55), number: 55, title: 'Issue 55', milestone: 'artifact-tracking 0.2.0' },
    { key: key(62), number: 62, title: 'Issue 62', milestone: 'artifact-tracking 0.2.0' },
    { key: key(90), number: 90, title: 'Issue 90', milestone: 'other 0.3.0' },
  ])
  assert.deepEqual(runner.calls[0].body.variables, {
    owner: 'martin-macak',
    name: 'claude-code-mod-tracking',
    cursor: null,
  })
})

test('readMilestoneIssues follows the next page of a milestone', () => {
  const runner = fakeRunner((_args, body) =>
    body.variables.number === 1
      ? ok({
          data: {
            repository: {
              milestone: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ number: 63, title: 'Issue 63' }] } },
            },
          },
        })
      : ok(milestonePage([milestone(1, 'artifact-tracking 0.2.0', [55], 'C9')])),
  )
  const out = readMilestoneIssues(makeGh(runner), { repo: REPO })
  assert.deepEqual(
    out.map(i => i.number),
    [55, 63],
  )
  assert.equal(runner.calls[1].body.variables.cursor, 'C9')
})

test('readMilestoneIssues reads a milestone that no project issue uses yet', () => {
  // A new milestone, whose issues were filed by hand: the case that the report is for.
  const runner = fakeRunner(() => ok(milestonePage([milestone(3, 'artifact-tracking 0.3.0', [91])])))
  const out = readMilestoneIssues(makeGh(runner), { repo: REPO })
  assert.deepEqual(out, [{ key: key(91), number: 91, title: 'Issue 91', milestone: 'artifact-tracking 0.3.0' }])
  assert.equal(runner.calls.length, 1)
})

test('itemEditArgs builds the gh project item-edit call for each field type', () => {
  const base = ['project', 'item-edit', '--project-id', 'PVT_1', '--id', 'PVTI_1']
  const f = live.fields
  assert.deepEqual(itemEditArgs({ projectId: 'PVT_1', itemId: 'PVTI_1', field: f.Status, value: 'Ready' }), [
    ...base,
    '--field-id',
    f.Status.id,
    '--single-select-option-id',
    'f75ad846',
  ])
  assert.deepEqual(itemEditArgs({ projectId: 'PVT_1', itemId: 'PVTI_1', field: f.Order, value: 22.5 }), [
    ...base,
    '--field-id',
    f.Order.id,
    '--number',
    '22.5',
  ])
  assert.deepEqual(itemEditArgs({ projectId: 'PVT_1', itemId: 'PVTI_1', field: f['Blocked by'], value: '#55, #62' }), [
    ...base,
    '--field-id',
    f['Blocked by'].id,
    '--text',
    '#55, #62',
  ])
})

test('itemEditArgs rejects an option the field does not have', () => {
  assert.throws(
    () => itemEditArgs({ projectId: 'P', itemId: 'I', field: live.fields.Wave, value: 'Wave 9' }),
    err => err instanceof PlanError && /"Wave 9"/.test(err.message),
  )
})

test('applyChanges writes one field per call, in order, and returns the changes', () => {
  const runner = fakeRunner(() => ok(''))
  const changes = [
    { itemId: 'PVTI_a', number: 56, field: 'Status', from: 'Blocked', to: 'Ready' },
    { itemId: 'PVTI_a', number: 56, field: 'Blocked by', from: '#55', to: '—' },
  ]
  const done = applyChanges(makeGh(runner), { projectId: 'PVT_1', fields: live.fields, changes })
  assert.deepEqual(done, changes)
  assert.equal(runner.calls.length, 2)
  assert.deepEqual(runner.calls[1].args.slice(-2), ['--text', '—'])
})

test('applyChanges stops at the first failure and says what was written before it', () => {
  const runner = fakeRunner((_args, _body, n) =>
    n === 2 ? fail(1, 'gh: Resource not accessible by personal access token (HTTP 403)') : ok(''),
  )
  const changes = [
    { itemId: 'PVTI_a', number: 1, field: 'Status', to: 'Ready' },
    { itemId: 'PVTI_b', number: 2, field: 'Status', to: 'Ready' },
    { itemId: 'PVTI_c', number: 3, field: 'Status', to: 'Ready' },
  ]
  assert.throws(
    () => applyChanges(makeGh(runner), { projectId: 'PVT_1', fields: live.fields, changes }),
    err => err.kind === 'auth' && err.applied.length === 1 && err.applied[0].number === 1,
  )
  assert.equal(runner.calls.length, 2)
})

test('the project query reads the items in position order', () => {
  const runner = fakeRunner(() =>
    ok({ data: { repositoryOwner: { projectV2: snapshot.data.repositoryOwner.projectV2 } } }),
  )
  readProject(makeGh(runner), { owner: 'martin-macak', number: 3 })
  assert.match(
    runner.calls[0].body.query,
    /items\(first: 100, after: \$cursor, orderBy: \{ field: POSITION, direction: ASC \}\)/,
  )
})

test('applyMoves sends one updateProjectV2ItemPosition per move, in order, with null for the top', () => {
  const runner = fakeRunner(() => ok({ data: { updateProjectV2ItemPosition: { clientMutationId: null } } }))
  const moves = [
    { itemId: 'PVTI_a', afterId: null },
    { itemId: 'PVTI_b', afterId: 'PVTI_a' },
  ]
  assert.deepEqual(applyMoves(makeGh(runner), { projectId: 'PVT_1', moves }), moves)
  assert.deepEqual(
    runner.calls.map(c => c.body.variables),
    [
      { projectId: 'PVT_1', itemId: 'PVTI_a', afterId: null },
      { projectId: 'PVT_1', itemId: 'PVTI_b', afterId: 'PVTI_a' },
    ],
  )
  assert.match(
    runner.calls[0].body.query,
    /updateProjectV2ItemPosition\(input: \{ projectId: \$projectId, itemId: \$itemId, afterId: \$afterId \}\)/,
  )
})

test('applyMoves stops at the first failure and says what moved before it', () => {
  const runner = fakeRunner((_args, _body, n) =>
    n === 2 ? fail(1, 'gh: Resource not accessible by personal access token (HTTP 403)') : ok({ data: {} }),
  )
  const moves = [
    { itemId: 'PVTI_a', afterId: null },
    { itemId: 'PVTI_b', afterId: 'PVTI_a' },
    { itemId: 'PVTI_c', afterId: 'PVTI_b' },
  ]
  assert.throws(
    () => applyMoves(makeGh(runner), { projectId: 'PVT_1', moves }),
    err => err.kind === 'auth' && err.applied.length === 1 && err.applied[0].itemId === 'PVTI_a',
  )
  assert.equal(runner.calls.length, 2)
})

test('addToProject sends addProjectV2ItemById with the project id and the node id, and returns the id of the item', () => {
  const runner = fakeRunner(() => ok({ data: { addProjectV2ItemById: { item: { id: 'PVTI_new' } } } }))
  assert.equal(addToProject(makeGh(runner), { projectId: 'PVT_1', contentId: 'I_66' }), 'PVTI_new')
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(runner.calls[0].body.variables, { projectId: 'PVT_1', contentId: 'I_66' })
  assert.match(runner.calls[0].body.query, /addProjectV2ItemById\(input: \{ projectId: \$projectId, contentId: \$contentId \}\)/)
  assert.match(runner.calls[0].body.query, /item \{ id \}/)
})

test('addToProject gives null when GitHub answers with no item', () => {
  for (const data of [{ addProjectV2ItemById: { item: null } }, { addProjectV2ItemById: null }, {}]) {
    const runner = fakeRunner(() => ok({ data }))
    assert.equal(addToProject(makeGh(runner), { projectId: 'PVT_1', contentId: 'I_66' }), null, JSON.stringify(data))
  }
})

test('addToProject fails with the kind of the gh failure', () => {
  const runner = fakeRunner(() => fail(1, 'gh: Resource not accessible by personal access token (HTTP 403)'))
  assert.throws(
    () => addToProject(makeGh(runner), { projectId: 'PVT_1', contentId: 'I_66' }),
    err => err instanceof GhError && err.kind === 'auth',
  )
})

test('resolveContent tells an issue from a PR, and gives the URL, the node id, the state and the milestone', () => {
  // The REST reply of gh api repos/<repo>/issues/<n> (fields trimmed), as it was on 2026-10-18.
  const gh = makeGh(
    fakeRunner(args =>
      ok(
        args[1].endsWith('/60')
          ? {
              html_url: 'https://github.com/o/r/pull/60',
              repository_url: 'https://api.github.com/repos/o/r',
              node_id: 'PR_60',
              number: 60,
              pull_request: { url: 'https://api.github.com/repos/o/r/pulls/60' },
              state: 'open',
              title: 'PR',
              milestone: null,
            }
          : {
              html_url: 'https://github.com/o/r/issues/66',
              repository_url: 'https://api.github.com/repos/o/r',
              node_id: 'I_66',
              number: 66,
              state: 'closed',
              title: 'Issue',
              milestone: { number: 1, title: 'o 0.2.0', state: 'open' },
            },
      ),
    ),
  )
  assert.deepEqual(resolveContent(gh, { repo: 'o/r', number: 60 }), {
    url: 'https://github.com/o/r/pull/60',
    id: 'PR_60',
    repo: 'o/r',
    number: 60,
    kind: 'pr',
    state: 'OPEN',
    title: 'PR',
    milestone: null,
  })
  assert.deepEqual(resolveContent(gh, { repo: 'o/r', number: 66 }), {
    url: 'https://github.com/o/r/issues/66',
    id: 'I_66',
    repo: 'o/r',
    number: 66,
    kind: 'issue',
    state: 'CLOSED',
    title: 'Issue',
    milestone: { number: 1, title: 'o 0.2.0', state: 'OPEN' },
  })
})

test('resolveContent gives the name of the repo in the letter case that GraphQL uses', () => {
  // gh on 2026-10-18: a repo path in capitals still gets the repository_url of the repo as it is named.
  const reply = { repository_url: 'https://api.github.com/repos/martin-macak/claude-code-mod-tracking', state: 'open' }
  const runner = fakeRunner(() => ok(reply))
  const gh = makeGh(runner)
  assert.equal(resolveContent(gh, { repo: 'MARTIN-MACAK/CLAUDE-CODE-MOD-TRACKING', number: 66 }).repo, REPO)
  assert.deepEqual(runner.calls[0].args, ['api', 'repos/MARTIN-MACAK/CLAUDE-CODE-MOD-TRACKING/issues/66'])
})

// --- readComplete: a read that is checked, read again before a write, and retried (issue #228) ---

// A runner that answers the n-th project read with replies[n-1]. The last reply repeats.
const readsRunner = replies => fakeRunner((_args, _body, n) => ok(replies[Math.min(n, replies.length) - 1]))
// A sleep that records the pauses, so that a test checks the order and the delays, not the wall time.
const fakeSleep = () => {
  const sleep = ms => sleep.pauses.push(ms)
  sleep.pauses = []
  return sleep
}
const TARGET = { owner: 'martin-macak', number: 3 }
const good = () => projectPage(ALL_NODES)
const shortPage = () => projectPage(ALL_NODES.slice(0, 10), { total: 23 }) // hasNextPage false, 13 items cut off
const emptyProject = () => projectPage([], { total: 0 })

test('readComplete: a good read comes back at once, with no problem, no pause and one call', () => {
  const runner = readsRunner([good()])
  const sleep = fakeSleep()
  const read = readComplete(makeGh(runner), TARGET, { sleep })
  assert.deepEqual(read.problems, [])
  assert.equal(read.items.length, 23)
  assert.deepEqual(read.project, live.project)
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(sleep.pauses, [])
})

test('readComplete with twice reads two times, and a good pair comes back with no pause', () => {
  const runner = readsRunner([good()])
  const sleep = fakeSleep()
  const read = readComplete(makeGh(runner), TARGET, { twice: true, sleep })
  assert.deepEqual(read.problems, [])
  assert.equal(runner.calls.length, 2)
  assert.deepEqual(sleep.pauses, [])
})

test('readComplete: a short page with hasNextPage false is retried with a backoff, and the problem names the counts', () => {
  const runner = readsRunner([shortPage()])
  const sleep = fakeSleep()
  const read = readComplete(makeGh(runner), TARGET, { sleep })
  assert.equal(read.problems.length, 1)
  assert.match(read.problems[0], /listed 10 items, but GitHub counts 23/)
  assert.equal(runner.calls.length, READ_ATTEMPTS)
  assert.equal(read.attempts, READ_ATTEMPTS)
  assert.deepEqual(sleep.pauses, READ_BACKOFF_MS)
  assert.equal(READ_ATTEMPTS, READ_BACKOFF_MS.length + 1) // no pause after the last attempt
  assert.equal(
    READ_BACKOFF_MS.every((ms, i) => ms > 0 && (i === 0 || ms >= READ_BACKOFF_MS[i - 1])),
    true,
  )
})

test('readComplete: an empty project is a bad read, retried and then reported', () => {
  const runner = readsRunner([emptyProject()])
  const sleep = fakeSleep()
  const read = readComplete(makeGh(runner), TARGET, { sleep })
  assert.match(read.problems.join('\n'), /no item/)
  assert.equal(runner.calls.length, READ_ATTEMPTS)
  assert.equal(sleep.pauses.length, READ_ATTEMPTS - 1)
})

test('readComplete: a totalCount that disagrees with the items is a bad read', () => {
  const tooHigh = projectPage(ALL_NODES, { total: 24 })
  const tooLow = projectPage(ALL_NODES, { total: 22 })
  for (const reply of [tooHigh, tooLow]) {
    const read = readComplete(makeGh(readsRunner([reply])), TARGET, { sleep: fakeSleep() })
    assert.match(read.problems.join('\n'), /listed 23 items, but GitHub counts 2[24]/)
  }
})

test('readComplete: a totalCount that changes between two pages is a bad read', () => {
  const runner = fakeRunner((_args, body) =>
    ok(
      body.variables.cursor
        ? projectPage(ALL_NODES.slice(10), { total: 24 })
        : projectPage(ALL_NODES.slice(0, 10), { more: true, cursor: 'C1', total: 23 }),
    ),
  )
  const read = readComplete(makeGh(runner), TARGET, { sleep: fakeSleep() })
  assert.match(read.problems.join('\n'), /changed while the pages were read: 23, then 24/)
})

// The real answer of GitHub on 2026-10-22: 105 items in two pages, and the count on both.
const realPages = () => fakeRunner((_args, body) => ok(livePages[body.variables.cursor ? 1 : 0]))

test('readComplete: a real read of 2026-10-22 (105 of 105 in two pages) is complete, twice, with no pause', () => {
  const runner = realPages()
  const sleep = fakeSleep()
  const read = readComplete(makeGh(runner), TARGET, { twice: true, sleep })
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.totalCounts, [105, 105])
  assert.equal(read.items.length, 105)
  assert.equal(read.attempts, 1)
  assert.deepEqual(sleep.pauses, [])
  // Two reads of two pages each, the second page by the cursor of the first.
  assert.equal(runner.calls.length, 4)
  assert.equal(runner.calls[1].body.variables.cursor, livePages[0].data.repositoryOwner.projectV2.items.pageInfo.endCursor)
})

test('readComplete: the real first page alone (100 of 105, as the glitch gave) is a bad read', () => {
  // The same reply with hasNextPage false: the list ends early, and totalCount still says 105.
  const cut = structuredClone(livePages[0])
  cut.data.repositoryOwner.projectV2.items.pageInfo.hasNextPage = false
  const read = readComplete(makeGh(fakeRunner(() => ok(cut))), TARGET, { sleep: fakeSleep() })
  assert.equal(read.problems.length, 1)
  assert.match(read.problems[0], /listed 100 items, but GitHub counts 105/)
})

test('readComplete: a bad read that is good on the second try comes back clean after one pause', () => {
  const runner = readsRunner([emptyProject(), good()])
  const sleep = fakeSleep()
  const read = readComplete(makeGh(runner), TARGET, { sleep })
  assert.deepEqual(read.problems, [])
  assert.equal(read.items.length, 23)
  assert.equal(read.attempts, 2)
  assert.deepEqual(sleep.pauses, [READ_BACKOFF_MS[0]])
})

test('readComplete with twice: two reads that list different items are retried, and the problem names the counts', () => {
  // Each read is complete on its own: 23 of 23, then 22 of 22. Only the pair disagrees.
  const runner = fakeRunner((_args, _body, n) => ok(projectPage(n % 2 === 1 ? ALL_NODES : ALL_NODES.slice(1))))
  const sleep = fakeSleep()
  const read = readComplete(makeGh(runner), TARGET, { twice: true, sleep })
  assert.equal(read.problems.length, 1)
  assert.match(
    read.problems[0],
    /two reads list different items: 23 and 22 items, 1 only in the first, 0 only in the second/i,
  )
  assert.equal(runner.calls.length, 2 * READ_ATTEMPTS)
  assert.deepEqual(sleep.pauses, READ_BACKOFF_MS)
})

test('readComplete with twice: the second pair is good after a pair that disagreed', () => {
  const replies = [good(), projectPage(ALL_NODES.slice(1)), good(), good()]
  const sleep = fakeSleep()
  const read = readComplete(makeGh(readsRunner(replies)), TARGET, { twice: true, sleep })
  assert.deepEqual(read.problems, [])
  assert.equal(read.items.length, 23)
  assert.deepEqual(sleep.pauses, [READ_BACKOFF_MS[0]])
})

test('readComplete with twice: a bad first read is retried without a second read in the same try', () => {
  const runner = readsRunner([emptyProject(), good(), good()])
  const read = readComplete(makeGh(runner), TARGET, { twice: true, sleep: fakeSleep() })
  assert.deepEqual(read.problems, [])
  assert.equal(runner.calls.length, 3) // empty, then a good pair
})

test('readComplete with expectIds: a read that lacks items of an earlier read is retried and then reported', () => {
  const expectIds = new Set(ALL_NODES.map(n => n.id))
  const runner = readsRunner([projectPage(ALL_NODES.slice(0, 20))])
  const read = readComplete(makeGh(runner), TARGET, { expectIds, sleep: fakeSleep() })
  assert.match(read.problems.join('\n'), /lacks 3 of the 23 items that the read before it listed/)
  assert.equal(runner.calls.length, READ_ATTEMPTS)
})

// The pause of the CLI. Every other test passes a fake, so this one checks the real wait once.
test('sleepSync blocks for the time asked', () => {
  const start = performance.now()
  sleepSync(30)
  assert.ok(performance.now() - start >= 25)
})

test('readComplete does not retry a failed gh call: an auth failure stops at once', () => {
  const runner = fakeRunner(() => fail(1, 'gh: Bad credentials (HTTP 401)'))
  const sleep = fakeSleep()
  assert.throws(
    () => readComplete(makeGh(runner), TARGET, { sleep }),
    err => err instanceof GhError && err.kind === 'auth',
  )
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(sleep.pauses, [])
})

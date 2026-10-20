// IO of project-sync: every call to `gh` is here. Reads use `gh api graphql`, as do the add and the
// moves. The field edits use `gh project item-edit`. The rules are in core.mjs.
//
// makeGh(runner) wraps a runner: (args, stdin) => { status, stdout, stderr, error }.
// The tests pass a fake runner. The CLI passes spawnRunner.

import { spawnSync } from 'node:child_process'
import { issueKey, mergeIssueNodes, normalizeProject, PlanError, unloadedOpenIds } from './core.mjs'

// A failed gh call. kind: 'auth' (login, token or scope), 'missing' (no gh) or 'other'.
export class GhError extends Error {
  constructor(kind, message, extra = {}) {
    super(message)
    this.name = 'GhError'
    this.kind = kind
    Object.assign(this, extra)
  }
}

const RATE_LIMIT = /rate limit|abuse detection/i
const AUTH =
  /INSUFFICIENT_SCOPES|required scopes?|has not been granted|Bad credentials|HTTP 401|Requires authentication|gh auth login|GH_TOKEN|Resource not accessible|HTTP 403/i

// gh exits with 4 when it has no login. Other auth and scope failures show in the text.
// A rate limit answers HTTP 403 too, so it is checked first.
export function classifyFailure({ status, stdout = '', stderr = '' }) {
  if (status === 4) return 'auth'
  const text = `${stderr}\n${stdout}`
  if (RATE_LIMIT.test(text)) return 'other'
  return AUTH.test(text) ? 'auth' : 'other'
}

const firstLine = text =>
  String(text)
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)

export function spawnRunner(args, input) {
  return spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

export function makeGh(runner = spawnRunner) {
  const exec = (args, input) => {
    const r = runner(args, input)
    if (r.error?.code === 'ENOENT')
      throw new GhError('missing', 'gh is not installed. Install it from https://cli.github.com/.')
    // gh can exit before it reads its stdin. Then spawnSync reports EPIPE and still gives the status
    // and the streams. A failed run like that is finished, so its status and stderr classify it.
    // Status 0 is not: gh did not read the whole query, so its reply does not answer that query.
    const finished = r.error?.code === 'EPIPE' && typeof r.status === 'number' && r.status !== 0
    if (r.error && !finished) throw new GhError('other', `gh failed to start: ${r.error.message}`)
    if (r.status !== 0) {
      const message = firstLine(r.stderr) ?? firstLine(r.stdout) ?? `gh exited with status ${r.status}`
      throw new GhError(classifyFailure(r), message, { status: r.status, stderr: r.stderr, stdout: r.stdout })
    }
    return r.stdout
  }
  // One JSON body on stdin: typed variables, and no quoting of the query in a shell.
  const graphql = (query, variables = {}) => {
    const out = exec(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }))
    const body = JSON.parse(out)
    if (body.errors?.length > 0) {
      throw new GhError(classifyFailure({ status: 1, stdout: out }), body.errors[0].message ?? 'GraphQL error', {
        stdout: out,
      })
    }
    return body.data
  }
  const rest = path => JSON.parse(exec(['api', path]))
  return { exec, graphql, rest }
}

// --- Reads ---

// One page of the project: fields and 100 items, in the order of their manual position.
// owner is a user or an organization.
const PROJECT_QUERY = `query ProjectItems($owner: String!, $number: Int!, $cursor: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        title
        url
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { options { id name } }
          }
        }
        items(first: 100, after: $cursor, orderBy: { field: POSITION, direction: ASC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            type
            content {
              __typename
              ... on Issue {
                id
                number
                state
                title
                repository { nameWithOwner }
                milestone { number title state }
                blockedBy(first: 100) {
                  pageInfo { hasNextPage }
                  nodes { id number state repository { nameWithOwner } }
                }
              }
              ... on PullRequest { id number state title repository { nameWithOwner } }
              ... on DraftIssue { id title }
            }
            fieldValues(first: 50) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
              }
            }
          }
        }
      }
    }
  }
}`

// The blockers of issues that are not in the project, by node id.
const ISSUES_QUERY = `query IssuesByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      number
      state
      repository { nameWithOwner }
      blockedBy(first: 100) {
        pageInfo { hasNextPage }
        nodes { id number state repository { nameWithOwner } }
      }
    }
  }
}`

const MILESTONES_QUERY = `query OpenMilestones($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    milestones(first: 100, after: $cursor, states: OPEN) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        issues(first: 100, states: OPEN) {
          pageInfo { hasNextPage endCursor }
          nodes { number title }
        }
      }
    }
  }
}`

const MILESTONE_ISSUES_QUERY = `query MilestoneIssues($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    milestone(number: $number) {
      issues(first: 100, after: $cursor, states: OPEN) {
        pageInfo { hasNextPage endCursor }
        nodes { number title }
      }
    }
  }
}`

// Reads every page of the project. Returns normalizeProject()'s result.
export function readProject(gh, { owner, number }) {
  let first = null
  const nodes = []
  let cursor = null
  do {
    const data = gh.graphql(PROJECT_QUERY, { owner, number, cursor })
    const project = data?.repositoryOwner?.projectV2
    if (!project) {
      throw new GhError(
        'auth',
        `GitHub did not return project ${number} of ${owner}. The number may be wrong, or this token cannot read it.`,
      )
    }
    first ??= project
    nodes.push(...project.items.nodes)
    cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null
  } while (cursor)
  return normalizeProject({ ...first, items: { nodes } })
}

// JSON in a failed reply may be missing or cut off. Null then.
const parseJson = text => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// The nodes of `ids`, in the same order, with null for an id that GitHub cannot resolve. When an
// id does not resolve, gh exits 1, but the body on stdout still holds data.nodes, with null for
// that id. graphql() also throws on a body with errors when gh exits 0. Both end up here with the
// body in err.stdout. Any other error stops the run.
export function issueNodes(gh, ids) {
  try {
    return gh.graphql(ISSUES_QUERY, { ids }).nodes
  } catch (err) {
    const body = err instanceof GhError ? parseJson(err.stdout) : null
    const onlyNotFound = body?.errors?.length > 0 && body.errors.every(e => e.type === 'NOT_FOUND')
    if (onlyNotFound && Array.isArray(body.data?.nodes)) return body.data.nodes
    throw err
  }
}

// Loads the blockers of the open issues that are not in the project, and theirs in turn,
// until the graph is closed. Returns warnings.
export function loadBlockers(gh, graph) {
  const warnings = []
  for (let ids = unloadedOpenIds(graph); ids.length > 0; ids = unloadedOpenIds(graph)) {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50)
      warnings.push(...mergeIssueNodes(graph, issueNodes(gh, chunk), chunk))
    }
  }
  return warnings
}

// The open issues of every open milestone of `repo`. A milestone that no project issue uses yet
// is read too: the report is for issues that nobody added to the project.
export function readMilestoneIssues(gh, { repo }) {
  const [owner, name] = repo.split('/')
  const out = []
  let cursor = null
  do {
    const { milestones } = gh.graphql(MILESTONES_QUERY, { owner, name, cursor }).repository
    for (const m of milestones.nodes) {
      let page = m.issues
      for (;;) {
        for (const i of page.nodes)
          out.push({ key: issueKey(repo, i.number), number: i.number, title: i.title, milestone: m.title })
        if (!page.pageInfo.hasNextPage) break
        page = gh.graphql(MILESTONE_ISSUES_QUERY, { owner, name, number: m.number, cursor: page.pageInfo.endCursor })
          .repository.milestone.issues
      }
    }
    cursor = milestones.pageInfo.hasNextPage ? milestones.pageInfo.endCursor : null
  } while (cursor)
  return out
}

// An issue and a PR share the number space, so one REST call tells which one it is. It gives what
// an item that is not in the project yet needs: the node id (the id that GraphQL uses), the repo
// named as GraphQL names it (the caller may have typed another letter case), the kind, the state
// and the milestone. REST says "open", GraphQL says "OPEN", so the states are upper case.
export function resolveContent(gh, { repo, number }) {
  const r = gh.rest(`repos/${repo}/issues/${number}`)
  return {
    url: r.html_url,
    id: r.node_id,
    repo: r.repository_url?.split('/repos/')[1] ?? repo,
    number,
    kind: r.pull_request ? 'pr' : 'issue',
    state: String(r.state).toUpperCase(),
    title: r.title,
    milestone: r.milestone
      ? { number: r.milestone.number, title: r.milestone.title, state: String(r.milestone.state).toUpperCase() }
      : null,
  }
}

// --- Writes ---

// gh project item-edit sets one field per call. field = { id, dataType, options }.
export function itemEditArgs({ projectId, itemId, field, value }) {
  const base = ['project', 'item-edit', '--project-id', projectId, '--id', itemId, '--field-id', field.id]
  if (field.dataType === 'SINGLE_SELECT') {
    const option = field.options.find(o => o.name === value)
    if (!option) {
      throw new PlanError(`The field has no option "${value}". Options: ${field.options.map(o => o.name).join(', ')}.`)
    }
    return [...base, '--single-select-option-id', option.id]
  }
  if (field.dataType === 'NUMBER') return [...base, '--number', String(value)]
  return [...base, '--text', String(value)]
}

export function setField(gh, { projectId, itemId, field, value }) {
  gh.exec(itemEditArgs({ projectId, itemId, field, value }))
}

// Runs `write` for each entry of `list`, in order. Stops at the first failure; the error has
// `applied`, the entries that were written before it.
function writeAll(list, write) {
  const applied = []
  for (const entry of list) {
    try {
      write(entry)
    } catch (err) {
      err.applied = applied
      throw err
    }
    applied.push(entry)
  }
  return applied
}

// Writes the planned changes in order. Returns the changes that were written. A failure stops it,
// and the error has `applied`, the changes that were written before it (see writeAll).
export const applyChanges = (gh, { projectId, fields, changes }) =>
  writeAll(changes, c => setField(gh, { projectId, itemId: c.itemId, field: fields[c.field], value: c.to }))

const MOVE_MUTATION = `mutation MoveItem($projectId: ID!, $itemId: ID!, $afterId: ID) {
  updateProjectV2ItemPosition(input: { projectId: $projectId, itemId: $itemId, afterId: $afterId }) { clientMutationId }
}`

// Moves one item to the place after afterId (null: the top). gh project has no command for it.
export function moveItem(gh, { projectId, itemId, afterId }) {
  gh.graphql(MOVE_MUTATION, { projectId, itemId, afterId })
}

// Writes the moves in order, each on the list that the move before it left. Returns the moves
// that were written. A failure stops it, and the error has `applied`, the moves that were written
// before it (see writeAll).
export const applyMoves = (gh, { projectId, moves }) =>
  writeAll(moves, m => moveItem(gh, { projectId, itemId: m.itemId, afterId: m.afterId }))

const ADD_MUTATION = `mutation AddItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`

// Adds an issue or a PR to the project, and returns the id of its project item (null when GitHub
// gives none). The id is the answer of the add itself: the list of the project may show the new
// item only minutes later, so the caller must not wait for it there. `contentId` is the node id of
// the issue or PR. An item that is in the project already is not added again: GitHub gives its id.
export function addToProject(gh, { projectId, contentId }) {
  return gh.graphql(ADD_MUTATION, { projectId, contentId })?.addProjectV2ItemById?.item?.id ?? null
}

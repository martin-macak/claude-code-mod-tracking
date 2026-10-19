import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GhError } from '../scripts/gh.mjs'
import { main } from '../scripts/sync.mjs'
import { issueNode, moveAfter, REPO, snapshot } from './helpers.mjs'

const SYNC = fileURLToPath(new URL('../scripts/sync.mjs', import.meta.url))
const PROJECT_ID = 'PVT_kwHOAA7Bx84BnlRd'
const FIELD = {
  Status: 'PVTSSF_lAHOAA7Bx84BnlRdzhmJMqY',
  Wave: 'PVTSSF_lAHOAA7Bx84BnlRdzhmJckk',
  Release: 'PVTSSF_lAHOAA7Bx84BnlRdzhmJckw',
  Area: 'PVTSSF_lAHOAA7Bx84BnlRdzhmJck0',
  Order: 'PVTF_lAHOAA7Bx84BnlRdzhmJcl0',
  'Blocked by': 'PVTF_lAHOAA7Bx84BnlRdzhmJcnA',
}
const MILESTONE = [55, 62, 63, 48, 56, 64, 65]

const fresh = () => structuredClone(snapshot)
const nodesOf = data => data.data.repositoryOwner.projectV2.items.nodes
const nodeOf = (data, number) => nodesOf(data).find(n => n.content?.number === number)
function setValue(data, number, field, value) {
  const v = nodeOf(data, number).fieldValues.nodes.find(x => x.field?.name === field)
  if ('text' in v) v.text = value
  else if ('number' in v) v.number = value
  else v.name = value
}
const dropOption = (data, field, name) => {
  const f = data.data.repositoryOwner.projectV2.fields.nodes.find(x => x.name === field)
  f.options = f.options.filter(o => o.name !== name)
}

// What gh project item-edit does to the data: it sets one field value of one item.
function applyEdit(data, args) {
  const arg = flag => args[args.indexOf(flag) + 1]
  const field = data.data.repositoryOwner.projectV2.fields.nodes.find(f => f.id === arg('--field-id'))
  let value
  if (args.includes('--number')) value = { number: Number(arg('--number')) }
  else if (args.includes('--text')) value = { text: arg('--text') }
  else value = { name: field.options.find(o => o.id === arg('--single-select-option-id')).name }
  const values = nodesOf(data).find(n => n.id === arg('--id')).fieldValues.nodes
  const old = values.findIndex(v => v.field?.name === field.name)
  if (old >= 0) values.splice(old, 1)
  values.push({ ...value, field: { name: field.name } })
}

// An in-process gh that answers from the snapshot and records every call. A write changes the data
// that the next read returns, as GitHub does. issues: the answer of IssuesByIds, by node id.
function fakeGh({
  project = fresh(),
  afterAdd = null,
  content = {},
  issues = {},
  inMilestone = MILESTONE,
  execFail = null,
  moveFail = null,
  moveNoop = false,
} = {}) {
  const calls = []
  let added = false
  const current = () => (added && afterAdd ? afterAdd : project)
  return {
    calls,
    graphql(query, variables) {
      const op = /(?:query|mutation) (\w+)/.exec(query)[1]
      calls.push({ type: 'graphql', op, variables })
      if (op === 'ProjectItems') return current().data
      if (op === 'MoveItem') {
        if (moveFail?.at === calls.filter(c => c.op === 'MoveItem').length) throw moveFail.error
        if (!moveNoop) {
          const nodes = nodesOf(current())
          nodes.splice(0, nodes.length, ...moveAfter(nodes, variables.itemId, variables.afterId, x => x.id))
        }
        return { updateProjectV2ItemPosition: { clientMutationId: null } }
      }
      if (op === 'OpenMilestones') {
        const milestone = {
          number: 1,
          title: 'artifact-tracking 0.2.0',
          issues: {
            pageInfo: { hasNextPage: false },
            nodes: inMilestone.map(number => ({ number, title: `Issue ${number}` })),
          },
        }
        return { repository: { milestones: { pageInfo: { hasNextPage: false }, nodes: [milestone] } } }
      }
      if (op === 'IssuesByIds') {
        if (calls.filter(c => c.op === 'IssuesByIds').length > 5) throw new Error('loadBlockers does not end')
        const nodes = variables.ids.map(id => issues[id] ?? null)
        const failed = variables.ids.flatMap((id, i) => (issues[id] ? [] : [[i, id]]))
        if (failed.length === 0) return { nodes }
        // gh on 2026-10-18 for an id that does not resolve: exit 1, the message on stderr, and on
        // stdout a body with the nodes that did resolve and null for the others.
        const errors = failed.map(([i, id]) => ({
          type: 'NOT_FOUND',
          path: ['nodes', i],
          message: `Could not resolve to a node with the global id of '${id}'`,
        }))
        throw new GhError('other', `gh: ${errors[0].message}`, {
          status: 1,
          stdout: JSON.stringify({ data: { nodes }, errors }),
        })
      }
      throw new Error(`unexpected GraphQL operation ${op}`)
    },
    exec(args) {
      const n = calls.filter(c => c.type === 'exec').length + 1
      calls.push({ type: 'exec', args })
      if (execFail?.at === n) throw execFail.error
      if (args[1] === 'item-add') added = true
      if (args[1] === 'item-edit') applyEdit(current(), args)
      return ''
    },
    rest(path) {
      calls.push({ type: 'rest', path })
      return content[path]
    },
  }
}
const writes = gh => gh.calls.filter(c => c.type === 'exec').map(c => c.args)
const moves = gh => gh.calls.filter(c => c.op === 'MoveItem')

// The snapshot with its items in Order sequence (a tie: issue, PR, draft, then number or title),
// so that the item positions need no move.
function inOrder(data) {
  const rank = n => ({ Issue: 0, PullRequest: 1, DraftIssue: 2 })[n.content.__typename]
  const order = n => n.fieldValues.nodes.find(v => v.field?.name === 'Order')?.number
  const name = n => n.content.number ?? n.content.title
  nodesOf(data).sort(
    (a, b) =>
      order(a) - order(b) ||
      rank(a) - rank(b) ||
      (typeof name(a) === 'number' ? name(a) - name(b) : String(name(a)).localeCompare(String(name(b)))),
  )
  return data
}

function run(args, gh = fakeGh()) {
  const out = []
  const err = []
  const code = main(args, { gh, stdout: s => out.push(s), stderr: s => err.push(s), sleep: () => {} })
  return { code, out: out.join('\n'), err: err.join('\n'), gh }
}

const editArgs = (itemId, field, ...value) => [
  'project',
  'item-edit',
  '--project-id',
  PROJECT_ID,
  '--id',
  itemId,
  '--field-id',
  FIELD[field],
  ...value,
]

test('--help prints the usage and exits 0; no command or an unknown command exits 2', () => {
  const help = run(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.out, /Usage: sync\.mjs <command>/)
  assert.match(help.out, /sync .*--apply/)
  for (const args of [[], ['frobnicate']]) {
    const r = run(args)
    assert.equal(r.code, 2, args.join(' '))
    assert.match(r.err, /Usage: sync\.mjs/)
  }
  assert.equal(run(['sync', '--nope']).code, 2)
})

test('sync on a project that is in sync reports no change and writes nothing', () => {
  const r = run(['sync'], fakeGh({ project: inOrder(fresh()) }))
  assert.equal(r.code, 0)
  assert.match(r.out, /Project "artifact-tracking 0\.2\.0": https:\/\/github\.com\/users\/martin-macak\/projects\/3/)
  assert.match(r.out, /Items: 23 \(issues 12, PRs 5, drafts 6\)\./)
  assert.match(r.out, /Planned changes: none\./)
  assert.match(r.out, /Item positions: in order\./)
  assert.match(r.out, /Cycles: none\./)
  assert.deepEqual(writes(r.gh), [])
  assert.deepEqual(moves(r.gh), [])
})

test('the defaults are owner martin-macak, project 3 and this repo; flags override them', () => {
  const r = run(['sync'])
  const read = r.gh.calls.find(c => c.op === 'ProjectItems')
  assert.deepEqual(read.variables, { owner: 'martin-macak', number: 3, cursor: null })
  const other = run(['sync', '--owner', 'acme', '--project', '9', '--repo', 'acme/lib'])
  assert.deepEqual(other.gh.calls.find(c => c.op === 'ProjectItems').variables, {
    owner: 'acme',
    number: 9,
    cursor: null,
  })
  assert.equal(run(['sync', '--project', 'x']).code, 2)
  assert.equal(run(['sync', '--repo', 'nope']).code, 2)
})

function drift() {
  const project = inOrder(fresh())
  setValue(project, 64, 'Status', 'Blocked') // #64 has no open blocker, so sync plans Ready
  return project
}

test('a dry run lists the change and writes nothing', () => {
  const r = run(['sync'], fakeGh({ project: drift() }))
  assert.equal(r.code, 0)
  assert.match(
    r.out,
    /Planned changes \(1\):\n {2}#64 Take the plugin version from the release tag\n {4}Status: Blocked -> Ready/,
  )
  assert.match(r.out, /Dry run: nothing was written\. Pass --apply to write the planned changes\./)
  assert.deepEqual(writes(r.gh), [])
})

test('--apply writes each change with gh project item-edit and says so', () => {
  const r = run(['sync', '--apply'], fakeGh({ project: drift() }))
  assert.equal(r.code, 0)
  assert.deepEqual(writes(r.gh), [editArgs(nodeOf(fresh(), 64).id, 'Status', '--single-select-option-id', 'f75ad846')])
  assert.match(r.out, /Applied 1 change\./)
})

test('--json prints one JSON document and nothing else on stdout', () => {
  const r = run(['sync', '--json'], fakeGh({ project: drift() }))
  const doc = JSON.parse(r.out)
  assert.equal(doc.apply, false)
  assert.equal(doc.project.number, 3)
  assert.deepEqual(
    doc.changes.map(c => [c.number, c.field, c.from, c.to]),
    [[64, 'Status', 'Blocked', 'Ready']],
  )
  for (const k of ['cycles', 'inversions', 'missingFromProject', 'noStatus', 'warnings', 'items'])
    assert.ok(Array.isArray(doc[k]), k)
  assert.equal(doc.items.length, 23)
  assert.deepEqual(doc.options.Area, ['core', 'ux', 'trackers', 'tooling', 'release'])
  assert.deepEqual(doc.options.Release, ['0.2.0', 'Later', 'Tooling'])
  const it = doc.items.find(i => i.number === 56)
  assert.deepEqual([it.kind, it.fields.Order, it.fields.Area], ['issue', 10, 'trackers'])
})

test('item positions: a dry run reports how many items move, and moves none', () => {
  const r = run(['sync'])
  assert.match(r.out, /Item positions \(11 of 23 items move to follow Order\):\n {2}#52 after #48\n {2}#53 after #51\n/)
  assert.match(r.out, /Dry run: nothing was written\. Pass --apply to write the planned position moves\./)
  assert.deepEqual(moves(r.gh), [])
  const doc = JSON.parse(run(['sync', '--json']).out)
  assert.equal(doc.positions.total, 23)
  assert.equal(doc.positions.moves.length, 11)
  assert.deepEqual(doc.moved, [])
  assert.equal(doc.positionsLeft, null)
})

test('--apply moves the items that are out of place with updateProjectV2ItemPosition, then checks the result', () => {
  const gh = fakeGh()
  const r = run(['sync', '--apply'], gh)
  assert.equal(r.code, 0)
  assert.equal(moves(gh).length, 11)
  assert.deepEqual(moves(gh)[0].variables, {
    projectId: PROJECT_ID,
    itemId: nodeOf(fresh(), 52).id,
    afterId: nodeOf(fresh(), 48).id,
  })
  assert.match(r.out, /Applied 11 position moves\./)
  assert.match(r.out, /Positions checked: the manual order follows Order\./)
  // GitHub lists the items in Order sequence now, so the next run has nothing to move.
  const again = run(['sync'], gh)
  assert.match(again.out, /Item positions: in order\./)
  assert.equal(moves(gh).length, 11)
})

test('--apply writes the field changes first and the position moves after them', () => {
  const project = fresh()
  setValue(project, 64, 'Status', 'Blocked')
  const gh = fakeGh({ project })
  const r = run(['sync', '--apply'], gh)
  const kinds = gh.calls
    .filter(c => c.type === 'exec' || c.op === 'MoveItem')
    .map(c => (c.type === 'exec' ? 'edit' : 'move'))
  assert.deepEqual(kinds, ['edit', ...Array(11).fill('move')])
  assert.match(r.out, /Applied 1 change and 11 position moves\./)
})

test('--json with --apply lists what was written', () => {
  const project = fresh()
  setValue(project, 64, 'Status', 'Blocked')
  const doc = JSON.parse(run(['sync', '--apply', '--json'], fakeGh({ project })).out)
  assert.equal(doc.applied.length, 1)
  assert.equal(doc.moved.length, 11)
  assert.equal(doc.positionsLeft, 0)
})

test('sync --apply gives an open issue without a Status one, and then does not list it as having none', () => {
  const project = inOrder(fresh())
  setValue(project, 64, 'Status', null) // #64 has no open blocker, so sync plans Ready
  const r = run(['sync', '--apply'], fakeGh({ project }))
  assert.equal(r.code, 0)
  assert.match(r.out, /Status: \(empty\) -> Ready/)
  assert.match(r.out, /Items with no Status: none\./)
})

test('a move that fails after the field writes: exit 3, and the writes before it are counted', () => {
  const project = fresh()
  setValue(project, 64, 'Status', 'Blocked')
  const error = new GhError('auth', 'gh: Resource not accessible by personal access token (HTTP 403)')
  const r = run(['sync', '--apply'], fakeGh({ project, moveFail: { at: 3, error } }))
  assert.equal(r.code, 3)
  assert.match(r.err, /cannot write/i)
  assert.match(r.err, /3 changes were written before the failure/)
})

test('positions that do not change after the moves: exit 1 and the reason', () => {
  const r = run(['sync', '--apply'], fakeGh({ moveNoop: true }))
  assert.equal(r.code, 1)
  assert.match(r.out, /Applied 11 position moves\./)
  assert.match(r.err, /11 items are still out of position after the moves/)
})

test('next --apply moves the positions too', () => {
  const gh = fakeGh()
  const r = run(['next', '--apply'], gh)
  assert.equal(r.code, 0)
  assert.equal(moves(gh).length, 11)
  assert.match(r.out, /Next: #64 /)
})

test('a missing Wave option fails loudly with exit 1 and writes nothing, also with --apply', () => {
  const project = drift()
  dropOption(project, 'Wave', 'Wave 2')
  const r = run(['sync', '--apply'], fakeGh({ project }))
  assert.equal(r.code, 1)
  assert.match(r.err, /Wave field has no option "Wave 2"/)
  assert.match(r.err, /project owner must add it/)
  assert.deepEqual(writes(r.gh), [])
})

test('a token that cannot read the project: exit 3, the message and the fallback order of AGENTS.md', () => {
  const gh = fakeGh()
  gh.graphql = () => {
    throw new GhError('auth', 'gh: Your token has not been granted the required scopes to execute this query.')
  }
  const r = run(['sync'], gh)
  assert.equal(r.code, 3)
  assert.equal(r.out, '')
  assert.match(r.err, /cannot read the GitHub Project/)
  assert.match(r.err, /required scopes/)
  assert.match(r.err, /unverified/i)
  // The three printed steps keep the order of the "No access" bullet of AGENTS.md at the repo root.
  const agents = readFileSync(new URL('../../../../AGENTS.md', import.meta.url), 'utf8')
  const bullet = agents.split('\n').find(l => l.startsWith('- **No access.**'))
  assert.ok(bullet, 'AGENTS.md has a "No access" bullet')
  const rules = ['milestone', 'native', 'issue number'] // how the bullet and the printed steps name the rules
  assert.ok(
    rules.every(rule => bullet.includes(rule)),
    bullet,
  )
  const inBullet = [...rules].sort((a, b) => bullet.indexOf(a) - bullet.indexOf(b))
  const steps = r.err.split('\n').filter(l => /^ {2}\d\. /.test(l))
  assert.deepEqual(
    steps.map(step => rules.filter(rule => step.includes(rule))),
    inBullet.map(rule => [rule]),
  )
  // Step 2 names a command that works on any gh, beside the short form (gh 2.94 or newer).
  assert.match(steps[1], /gh issue view <n> --json blockedBy/)
  assert.match(steps[1], /gh api repos\/martin-macak\/claude-code-mod-tracking\/issues\/<n>\/dependencies\/blocked_by/)
})

test('a failed gh call that is not about auth exits 1 and shows the gh message', () => {
  const gh = fakeGh()
  gh.graphql = () => {
    throw new GhError('other', 'gh: Server Error (HTTP 502)')
  }
  const r = run(['sync'], gh)
  assert.equal(r.code, 1)
  assert.match(r.err, /HTTP 502/)
  assert.doesNotMatch(r.err, /Fallback order/)
  assert.doesNotMatch(r.err, /written before the failure/) // a read failure: nothing was written
})

test('a move that fails with a server error: exit 1, the message, and how many writes landed before it', () => {
  // The 5th of the 11 moves fails, so 4 moves landed. The kind of the error does not hide that.
  const error = new GhError('other', 'gh: Server Error (HTTP 502)')
  const r = run(['sync', '--apply'], fakeGh({ moveFail: { at: 5, error } }))
  assert.equal(r.code, 1)
  assert.match(r.err, /project-sync: gh: Server Error \(HTTP 502\)/)
  assert.match(r.err, /4 changes were written before the failure\. Run the command again: it plans the rest\./)
  assert.doesNotMatch(r.err, /Fallback order|cannot read|cannot write/)
})

test('a field write that fails with a server error: exit 1, the message, and how many writes landed before it', () => {
  const project = drift()
  setValue(project, 63, 'Status', 'Ready') // #63 is blocked, so sync plans Blocked too
  const error = new GhError('other', 'gh: Server Error (HTTP 502)')
  const r = run(['sync', '--apply'], fakeGh({ project, execFail: { at: 2, error } }))
  assert.equal(r.code, 1)
  assert.match(r.err, /1 change was written before the failure\./)
})

test('a token that reads but cannot write: exit 3, and the changes written before it are named', () => {
  const project = drift()
  setValue(project, 63, 'Status', 'Ready') // #63 is blocked, so sync plans Blocked too
  const gh = fakeGh({
    project,
    execFail: { at: 2, error: new GhError('auth', 'gh: Resource not accessible by personal access token (HTTP 403)') },
  })
  const r = run(['sync', '--apply'], gh)
  assert.equal(r.code, 3)
  assert.match(r.err, /cannot write/i)
  assert.match(r.err, /1 change.* written before/)
  assert.doesNotMatch(r.err, /Fallback order/)
})

test('sync follows a blocker outside the project: Wave and Blocked by come from the whole chain', () => {
  // #56 waits for #55 (in the project) and for #70 (outside), which waits for #71 (outside).
  const project = fresh()
  const outside = number => ({ id: `I_${number}`, number, state: 'OPEN', repository: { nameWithOwner: REPO } })
  nodeOf(project, 56).content.blockedBy.nodes.push(outside(70))
  const issues = { I_70: issueNode(70, { blockers: [71] }), I_71: issueNode(71) }
  const doc = JSON.parse(run(['sync', '--json'], fakeGh({ project, issues })).out)
  assert.deepEqual(
    doc.changes.filter(c => c.number === 56).map(c => [c.field, c.to]),
    [
      ['Wave', 'Wave 2'],
      ['Blocked by', '#55, #70'],
    ],
  )
})

test('sync prints a warning about a blocker that GitHub cannot resolve, and keeps it in the --json document', () => {
  // #56 waits for an issue of a private repo. The token cannot read it, and gh exits 1 for it.
  const project = inOrder(fresh())
  const private999 = { id: 'I_private', number: 999, state: 'OPEN', repository: { nameWithOwner: 'other/private' } }
  nodeOf(project, 56).content.blockedBy.nodes.push(private999)
  const r = run(['sync', '--json'], fakeGh({ project }))
  assert.equal(r.code, 0)
  assert.match(r.err, /warning: other\/private#999 could not be read\. It counts as an open issue with no blockers\./)
  assert.equal(JSON.parse(r.out).warnings.length, 1)
})

test('sync lists the open milestone issues that are not in the project', () => {
  // #69 is in the milestone on GitHub and not in the project.
  const r = run(['sync'], fakeGh({ project: inOrder(fresh()), inMilestone: [...MILESTONE, 69] }))
  assert.match(
    r.out,
    /Open milestone issues missing from the project \(1\):\n {2}#69 Issue 69 \(milestone "artifact-tracking 0\.2\.0"\)/,
  )
})

test('a project without the Blocked by field fails loudly with exit 1 and writes nothing', () => {
  const project = fresh()
  const fields = project.data.repositoryOwner.projectV2.fields
  fields.nodes = fields.nodes.filter(f => f.name !== 'Blocked by')
  const r = run(['sync', '--apply'], fakeGh({ project }))
  assert.equal(r.code, 1)
  assert.match(r.err, /no field "Blocked by"/)
  assert.deepEqual(writes(r.gh), [])
})

test('next runs the sync report, then prints the Ready item with the lowest Wave and Order', () => {
  const r = run(['next'])
  assert.equal(r.code, 0)
  assert.match(r.out, /Planned changes: none\./)
  assert.match(
    r.out,
    /Next: #64 Take the plugin version from the release tag\n {2}https:\/\/github\.com\/martin-macak\/claude-code-mod-tracking\/issues\/64\n {2}Wave 0, Order 4, Release 0\.2\.0, Area release$/,
  )
  assert.deepEqual(writes(r.gh), [])
})

test('next uses the Status that sync would write, and writes it only with --apply', () => {
  // #55 is closed, so #56, #62 and #50 lose their only blocker. #64 is taken.
  const project = fresh()
  setValue(project, 64, 'Status', 'In progress')
  nodeOf(project, 55).content.state = 'CLOSED'
  for (const n of [56, 62, 50, 57, 49, 63, 65]) {
    const c = nodeOf(project, n).content
    c.blockedBy.nodes = c.blockedBy.nodes.filter(b => b.number !== 55)
  }
  const dry = run(['next', '--json'], fakeGh({ project }))
  const doc = JSON.parse(dry.out)
  assert.equal(doc.next.number, 56)
  assert.deepEqual(
    doc.ready.map(i => i.number),
    [56, 62, 50],
  )
  assert.deepEqual(writes(dry.gh), [])
  const applied = run(['next', '--apply'], fakeGh({ project }))
  assert.ok(writes(applied.gh).length > 0)
  assert.match(applied.out, /Applied \d+ changes? and 11 position moves\./)
  assert.match(applied.out, /Next: #56 /)
})

test('next picks the Ready item with the lowest Order among the Ready items of Wave 0', () => {
  const project = fresh()
  setValue(project, 51, 'Status', 'Ready') // #51 has Order 2, #64 has Order 4. Both have Wave 0 and no open blocker.
  const doc = JSON.parse(run(['next', '--json'], fakeGh({ project: inOrder(project) })).out)
  assert.deepEqual(
    doc.ready.map(i => i.number),
    [51, 64],
  )
  assert.equal(doc.next.number, 51)
})

test('next says so when nothing is Ready', () => {
  const project = fresh()
  setValue(project, 64, 'Status', 'In progress')
  assert.match(run(['next'], fakeGh({ project })).out, /Next: no Ready item\./)
  assert.equal(JSON.parse(run(['next', '--json'], fakeGh({ project })).out).next, null)
})

test('status sets one item by issue number and writes the option', () => {
  const r = run(['status', '64', 'In progress'])
  assert.equal(r.code, 0)
  assert.deepEqual(writes(r.gh), [editArgs(nodeOf(fresh(), 64).id, 'Status', '--single-select-option-id', '47fc9ee4')])
  assert.match(r.out, /#64 Take the plugin version from the release tag: Status Ready -> In progress/)
})

test('status takes #N, owner/repo#N and a URL for an issue or a PR', () => {
  for (const ref of ['#64', `${REPO}#64`, `https://github.com/${REPO}/issues/64`]) {
    assert.equal(writes(run(['status', ref, 'In review']).gh).length, 1, ref)
  }
  const pr = run(['status', `https://github.com/${REPO}/pull/60`, 'In progress'])
  assert.deepEqual(writes(pr.gh), [editArgs(nodeOf(fresh(), 60).id, 'Status', '--single-select-option-id', '47fc9ee4')])
})

test('status: a token that cannot write exits 3 and does not talk about reading', () => {
  const error = new GhError('auth', 'gh: Resource not accessible by personal access token (HTTP 403)')
  const r = run(['status', '64', 'In progress'], fakeGh({ execFail: { at: 1, error } }))
  assert.equal(r.code, 3)
  assert.match(r.err, /cannot write/i)
  assert.match(r.err, /0 changes were written before the failure/)
  assert.doesNotMatch(r.err, /Fallback order|cannot read/)
})

test('status finds a draft by its title, exact or as a unique part, and not by a prefix that fits two', () => {
  const exact = run(['status', '#55 L3: Lifecycle, event bus and ports', 'In review'])
  assert.equal(writes(exact.gh).length, 1)
  assert.match(exact.out, /draft "#55 L3: Lifecycle, event bus and ports": Status In progress -> In review/)
  assert.equal(writes(run(['status', 'config manager', 'Ready']).gh).length, 1)
  const two = run(['status', '#55 L', 'Ready'])
  assert.equal(two.code, 1)
  assert.match(two.err, /more than one item/)
  assert.match(two.err, /L3/)
  assert.deepEqual(writes(two.gh), [])
})

test('status checks the value and the item before it writes', () => {
  const bad = run(['status', '64', 'Finished'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /Status options: Blocked, Ready, In progress, In review, Done/)
  const missing = run(['status', '999', 'Ready'])
  assert.equal(missing.code, 1)
  assert.match(missing.err, /#999 is not in the project/)
  assert.equal(run(['status', '64']).code, 2)
  assert.deepEqual([...writes(bad.gh), ...writes(missing.gh)], [])
})

test('status matches the option name in any letter case, and writes nothing when the value is already set', () => {
  assert.equal(writes(run(['status', '64', 'in progress']).gh).length, 1)
  const same = run(['status', '64', 'ready'])
  assert.equal(same.code, 0)
  assert.match(same.out, /already Ready/)
  assert.deepEqual(writes(same.gh), [])
})

test('status refuses an empty or blank item, also when the project holds one draft only', () => {
  const oneDraft = () => {
    const p = fresh()
    p.data.repositoryOwner.projectV2.items.nodes = nodesOf(p).filter(
      n => n.content.__typename !== 'DraftIssue' || n.content.title === '#55 L4: Config manager',
    )
    return p
  }
  for (const item of ['', '  ']) {
    const r = run(['status', item, 'Ready'], fakeGh({ project: oneDraft() }))
    assert.equal(r.code, 2, JSON.stringify(item))
    assert.match(r.err, /status needs an issue or PR number/, JSON.stringify(item))
    assert.deepEqual(writes(r.gh), [], JSON.stringify(item))
  }
})

test('status never sets Done, whatever the item or the letter case: GitHub sets it', () => {
  for (const [item, value] of [
    ['64', 'Done'],
    ['64', 'done'],
    [`https://github.com/${REPO}/pull/60`, ' DONE '],
    ['#55 L3: Lifecycle, event bus and ports', 'Done'],
  ]) {
    const r = run(['status', item, value])
    assert.equal(r.code, 2, `${item} ${value}`)
    assert.match(r.err, /project-sync never sets Done\. GitHub sets it when the issue closes or the PR merges\./)
    assert.deepEqual(writes(r.gh), [], `${item} ${value}`)
  }
})

test('status reads the project and writes one field, and makes no other call', () => {
  const r = run(['status', '64', 'In progress'])
  assert.equal(r.code, 0)
  assert.deepEqual(
    r.gh.calls.map(c => c.op ?? c.type),
    ['ProjectItems', 'exec'],
  )
})

// #66 is out of the project before the add, and in it, with no values, after it: last, as GitHub
// puts a new item. `base` is the whole project. It is in Order sequence unless a test wants drift.
function projectsAround66(base = inOrder(fresh())) {
  const node = nodeOf(base, 66)
  const before = structuredClone(base)
  before.data.repositoryOwner.projectV2.items.nodes = nodesOf(before).filter(n => n.id !== node.id)
  const after = structuredClone(before)
  nodesOf(after).push({ ...structuredClone(node), id: 'PVTI_new66', fieldValues: { nodes: [] } })
  return { before, after }
}
const ID_66 = nodeOf(fresh(), 66).content.id
// The REST reply for #66 (fields trimmed), as gh api repos/<repo>/issues/66 gave it on 2026-10-18.
const ISSUE_66 = {
  html_url: `https://github.com/${REPO}/issues/66`,
  repository_url: `https://api.github.com/repos/${REPO}`,
  node_id: ID_66,
  number: 66,
  state: 'open',
  title: 'Make the GitHub Project part of the agent delivery workflow',
  milestone: null,
}
const addArgs = ['add', '66', '--order', '3', '--area', 'tooling', '--release', 'Tooling']
// The options of fakeGh for the add of #66: the project before and after, the REST reply, and the
// node that GraphQL gives for the new issue.
const around66 = ({ base, blockers = [] } = {}) => {
  const { before, after } = projectsAround66(base)
  return {
    project: before,
    afterAdd: after,
    content: { [`repos/${REPO}/issues/66`]: ISSUE_66 },
    issues: { [ID_66]: issueNode(66, { id: ID_66, blockers }) },
  }
}

test('add without --apply writes nothing: it shows the item, its fields and the plan as a dry run', () => {
  const gh = fakeGh(around66())
  const r = run(addArgs, gh)
  assert.equal(r.code, 0)
  assert.deepEqual(writes(gh), [])
  assert.deepEqual(moves(gh), [])
  assert.match(r.out, /^Would add #66 Make the GitHub Project part of the agent delivery workflow \(issue\)\.\n/)
  assert.match(r.out, /\n {2}Order: \(empty\) -> 3\n {2}Area: \(empty\) -> tooling\n {2}Release: \(empty\) -> Tooling\n/)
  assert.match(r.out, /Items: 23 \(issues 12, PRs 5, drafts 6\)\./)
  assert.match(
    r.out,
    /Planned changes \(3\):\n {2}#66 .*\n {4}Wave: \(empty\) -> Wave 0\n {4}Status: \(empty\) -> Ready\n {4}Blocked by: \(empty\) -> "—"\n/,
  )
  assert.match(r.out, /Item positions \(1 of 23 items move to follow Order\):\n {2}#66 after #53\n/)
  assert.match(
    r.out,
    /Dry run: nothing was written\. Pass --apply to write the planned new item, field values, changes and position moves\./,
  )
  assert.doesNotMatch(r.out, /Applied|Added/)
})

test('add without --apply plans Wave, Status and Blocked by from the blockers of the new issue', () => {
  const gh = fakeGh(around66({ blockers: [55] }))
  const r = run(addArgs, gh)
  assert.equal(r.code, 0)
  assert.deepEqual(writes(gh), [])
  assert.match(
    r.out,
    /Wave: \(empty\) -> Wave 1\n {4}Status: \(empty\) -> Blocked\n {4}Blocked by: \(empty\) -> "#55"/,
  )
})

test('add without --apply on an item that is in the project shows its field changes and the plan with the new values', () => {
  const project = inOrder(fresh())
  setValue(project, 64, 'Wave', 'Wave 2') // #64 has no open blocker, so sync plans Wave 0, Ready and the dash
  setValue(project, 64, 'Status', 'Blocked')
  setValue(project, 64, 'Blocked by', '#55')
  const r = run(['add', '64', '--order', '9.5', '--area', 'ux', '--release', 'Later'], fakeGh({ project }))
  assert.equal(r.code, 0)
  assert.deepEqual(writes(r.gh), [])
  assert.deepEqual(moves(r.gh), [])
  assert.match(r.out, /^Already in the project #64 /)
  assert.match(r.out, /\n {2}Order: 4 -> 9\.5\n {2}Area: release -> ux\n {2}Release: 0\.2\.0 -> Later\n/)
  assert.match(
    r.out,
    /Planned changes \(3\):\n {2}#64 .*\n {4}Wave: Wave 2 -> Wave 0\n {4}Status: Blocked -> Ready\n {4}Blocked by: "#55" -> "—"\n/,
  )
  // The new Order puts #64 between the draft with Order 9 and #56 with Order 10.
  assert.match(
    r.out,
    /Item positions \(1 of 23 items move to follow Order\):\n {2}#64 after draft "#55 L3: Lifecycle, event bus and ports"\n/,
  )
  assert.match(r.out, /Pass --apply to write the planned field values, changes and position moves\./)
})

test('add --apply puts the item in, writes its fields, then writes the whole plan of sync: every change and every move', () => {
  const base = inOrder(fresh())
  setValue(base, 64, 'Status', 'Blocked') // drift of another item: add fixes it too, as sync would
  const gh = fakeGh(around66({ base }))
  const r = run([...addArgs, '--apply'], gh)
  assert.equal(r.code, 0)
  assert.deepEqual(writes(gh), [
    ['project', 'item-add', '3', '--owner', 'martin-macak', '--url', ISSUE_66.html_url],
    editArgs('PVTI_new66', 'Order', '--number', '3'),
    editArgs('PVTI_new66', 'Area', '--single-select-option-id', 'f482c3cf'),
    editArgs('PVTI_new66', 'Release', '--single-select-option-id', 'a5a9c27b'),
    editArgs(nodeOf(fresh(), 64).id, 'Status', '--single-select-option-id', 'f75ad846'),
    editArgs('PVTI_new66', 'Wave', '--single-select-option-id', '63cc7c86'),
    editArgs('PVTI_new66', 'Status', '--single-select-option-id', 'f75ad846'),
    editArgs('PVTI_new66', 'Blocked by', '--text', '—'),
  ])
  // The new item goes after the last item with a lower Order, PR #53.
  assert.equal(moves(gh).length, 1)
  assert.deepEqual(moves(gh)[0].variables, {
    projectId: PROJECT_ID,
    itemId: 'PVTI_new66',
    afterId: nodeOf(fresh(), 53).id,
  })
  assert.match(r.out, /^Added #66 Make the GitHub Project part of the agent delivery workflow \(issue\)\./)
  assert.match(r.out, /Applied 4 changes and 1 position move\./)
  assert.match(r.out, /Positions checked: the manual order follows Order\./)
  assert.doesNotMatch(r.out, /planned for other items/)
  // Nothing is left to do: the next sync plans no change, and the items are in position.
  const again = run(['sync'], gh)
  assert.match(again.out, /Planned changes: none\./)
  assert.match(again.out, /Item positions: in order\./)
})

test('add --apply on an item in a list with drift: the plan keeps the target in place, and the target ends in its Order position', () => {
  // The list is reversed, so the longest run that is in order has one item: the first one, #49,
  // which has the highest Order. The fewest moves keep it there and move the 22 others around it.
  // The old add wrote only the moves of the target, so it wrote none, and left #49 on top.
  const project = inOrder(fresh())
  nodesOf(project).reverse()
  const target = nodeOf(project, 49)
  const gh = fakeGh({ project })
  const r = run(['add', '49', '--order', '22', '--area', 'trackers', '--release', 'Later', '--apply'], gh)
  assert.equal(r.code, 0)
  assert.deepEqual(writes(gh), [editArgs(target.id, 'Order', '--number', '22')])
  assert.equal(moves(gh).length, 22)
  assert.equal(
    moves(gh).some(m => m.variables.itemId === target.id),
    false,
  )
  assert.match(r.out, /Positions checked: the manual order follows Order\./)
  // GitHub lists the items in Order sequence now, and #49 is last: it has the highest Order.
  assert.equal(nodesOf(project).at(-1).id, target.id)
  assert.match(run(['sync'], gh).out, /Item positions: in order\./)
})

const PR_70 = {
  html_url: `https://github.com/${REPO}/pull/70`,
  repository_url: `https://api.github.com/repos/${REPO}`,
  node_id: 'PR_70',
  number: 70,
  state: 'open',
  title: 'A PR',
  milestone: null,
  pull_request: {},
}
function projectsAround70() {
  const before = inOrder(fresh())
  const after = structuredClone(before)
  nodesOf(after).push({
    id: 'PVTI_pr70',
    type: 'PULL_REQUEST',
    content: {
      __typename: 'PullRequest',
      id: 'PR_70',
      number: 70,
      state: 'OPEN',
      title: 'A PR',
      repository: { nameWithOwner: REPO },
    },
    fieldValues: { nodes: [] },
  })
  return { before, after }
}

test('add gives a PR the Status In review, and plans nothing for it', () => {
  const { before, after } = projectsAround70()
  const gh = fakeGh({ project: before, afterAdd: after, content: { [`repos/${REPO}/issues/70`]: PR_70 } })
  const r = run(['add', '70', '--order', '9', '--area', 'core', '--release', '0.2.0', '--apply'], gh)
  assert.equal(r.code, 0)
  assert.deepEqual(writes(gh).slice(-1), [editArgs('PVTI_pr70', 'Status', '--single-select-option-id', '1a515cff')])
  assert.match(r.out, /\(PR\)/)
  assert.match(r.out, /Planned changes: none\./)
  assert.equal(gh.calls.some(c => c.op === 'IssuesByIds'), false)
})

test('add on an item that is in the project already changes only what differs, and keeps its Status', () => {
  const project = inOrder(fresh())
  setValue(project, 60, 'Status', 'Done')
  const args = ['add', '60', '--order', '8', '--area', 'core', '--release', '0.2.0', '--apply']
  const same = run(args, fakeGh({ project }))
  assert.equal(same.code, 0)
  assert.match(same.out, /Already in the project #60 /)
  assert.deepEqual(writes(same.gh), [])
  const change = ['add', '60', '--order', '9.5', '--area', 'ux', '--release', 'Later']
  assert.deepEqual(writes(run(change, fakeGh({ project: structuredClone(project) })).gh), [])
  const moved = run([...change, '--apply'], fakeGh({ project }))
  assert.deepEqual(writes(moved.gh), [
    editArgs(nodeOf(project, 60).id, 'Order', '--number', '9.5'),
    editArgs(nodeOf(project, 60).id, 'Area', '--single-select-option-id', '4a00d1e7'),
    editArgs(nodeOf(project, 60).id, 'Release', '--single-select-option-id', 'e2653d01'),
  ])
})

test('add takes a URL, and --status overrides the default Status of a PR', () => {
  const { before, after } = projectsAround70()
  const gh = fakeGh({ project: before, afterAdd: after, content: { [`repos/${REPO}/issues/70`]: PR_70 } })
  const url = `https://github.com/${REPO}/pull/70`
  const args = ['add', url, '--order', '9', '--area', 'core', '--release', '0.2.0', '--status', 'In progress', '--apply']
  const r = run(args, gh)
  assert.equal(r.code, 0)
  assert.deepEqual(
    gh.calls.find(c => c.type === 'rest'),
    { type: 'rest', path: `repos/${REPO}/issues/70` },
  )
  assert.deepEqual(writes(gh).slice(-1), [editArgs('PVTI_pr70', 'Status', '--single-select-option-id', '47fc9ee4')])
})

test('add reads again when the new item is slow to show up, and fails after three reads', () => {
  const { before, after } = projectsAround70()
  const gh = fakeGh({ project: before, afterAdd: before, content: { [`repos/${REPO}/issues/70`]: PR_70 } })
  const sleeps = []
  const out = []
  const err = []
  const code = main(['add', '70', '--order', '9', '--area', 'core', '--release', '0.2.0', '--apply'], {
    gh,
    stdout: s => out.push(s),
    stderr: s => err.push(s),
    sleep: ms => sleeps.push(ms),
  })
  assert.equal(code, 1)
  assert.match(err.join('\n'), /did not show up in the project yet/)
  assert.equal(gh.calls.filter(c => c.op === 'ProjectItems').length, 4) // 1 before the add, 3 after it
  assert.deepEqual(sleeps, [1000, 1000])
  assert.equal(after.data.repositoryOwner.projectV2.items.nodes.length, 24)
})

test('add: a write that fails is reported with the count of every write before it, the item-add too', () => {
  const auth = new GhError('auth', 'gh: Resource not accessible by personal access token (HTTP 403)')
  const args = [...addArgs, '--apply']
  const noAdd = run(args, fakeGh({ ...around66(), execFail: { at: 1, error: auth } }))
  assert.equal(noAdd.code, 3)
  assert.match(noAdd.err, /cannot write/i)
  assert.match(noAdd.err, /0 changes were written before the failure/)
  // item-add is write 1 and Order is write 2, so Area is write 3: the item-add and Order landed.
  const noArea = run(args, fakeGh({ ...around66(), execFail: { at: 3, error: auth } }))
  assert.equal(noArea.code, 3)
  assert.match(noArea.err, /2 changes were written before the failure/)
  assert.doesNotMatch(noArea.err, /Fallback order/)
  // The first write of the plan is write 5, after the item-add and the three fields.
  const noPlan = run(args, fakeGh({ ...around66(), execFail: { at: 5, error: auth } }))
  assert.equal(noPlan.code, 3)
  assert.match(noPlan.err, /4 changes were written before the failure/)
  const server = run(
    args,
    fakeGh({ ...around66(), execFail: { at: 5, error: new GhError('other', 'gh: Server Error (HTTP 502)') } }),
  )
  assert.equal(server.code, 1)
  assert.match(server.err, /project-sync: gh: Server Error \(HTTP 502\)/)
  assert.match(server.err, /4 changes were written before the failure\. Run the command again: it plans the rest\./)
})

test('add checks every value before it writes anything', () => {
  const gh = fakeGh({ content: { [`repos/${REPO}/issues/66`]: ISSUE_66 } })
  const cases = [
    [['add', '66', '--area', 'tooling', '--release', 'Tooling'], /--order/],
    [['add', '66', '--order', '3', '--release', 'Tooling'], /--area/],
    [['add', '66', '--order', '3', '--area', 'tooling'], /--release/],
    [['add', '66', '--order', 'soon', '--area', 'tooling', '--release', 'Tooling'], /--order.*number/],
    [
      ['add', '66', '--order', '3', '--area', 'cooking', '--release', 'Tooling'],
      /Area options: core, ux, trackers, tooling, release/,
    ],
    [
      ['add', '66', '--order', '3', '--area', 'tooling', '--release', '9.9'],
      /Release options: 0\.2\.0, Later, Tooling/,
    ],
    [['add', '66', '--order', '3', '--area', 'tooling', '--release', 'Tooling', '--status', 'Nope'], /Status options/],
    [
      ['add', '66', '--order', '3', '--area', 'tooling', '--release', 'Tooling', '--status', 'Done'],
      /project-sync never sets Done\. GitHub sets it when the issue closes or the PR merges\./,
    ],
    [['add', '--order', '3', '--area', 'tooling', '--release', 'Tooling'], /issue or PR/],
  ]
  for (const [args, pattern] of cases) {
    for (const apply of [[], ['--apply']]) {
      const r = run([...args, ...apply], gh)
      assert.equal(r.code, 2, args.join(' '))
      assert.match(r.err, pattern, args.join(' '))
    }
  }
  assert.deepEqual(writes(gh), [])
})

test('add takes the repo in another letter case: the key is the one that GitHub gives, so the blockers load', () => {
  const { content, ...opts } = around66({ blockers: [55] })
  const typed = REPO.toUpperCase()
  const gh = fakeGh({ ...opts, content: { [`repos/${typed}/issues/66`]: content[`repos/${REPO}/issues/66`] } })
  const r = run(['add', `https://github.com/${typed}/issues/66`, ...addArgs.slice(2)], gh)
  assert.equal(r.code, 0)
  assert.deepEqual(writes(gh), [])
  assert.match(r.out, /^Would add #66 /)
  assert.match(r.out, /Wave: \(empty\) -> Wave 1\n {4}Status: \(empty\) -> Blocked\n {4}Blocked by: \(empty\) -> "#55"/)
  assert.equal(gh.calls.filter(c => c.op === 'IssuesByIds').length, 1)
})

test('add finds an item that is in the project when the repo is given in another letter case', () => {
  const project = inOrder(fresh())
  const typed = REPO.toUpperCase()
  const content = {
    [`repos/${typed}/issues/64`]: {
      html_url: `https://github.com/${REPO}/issues/64`,
      repository_url: `https://api.github.com/repos/${REPO}`,
      node_id: nodeOf(project, 64).content.id,
      number: 64,
      state: 'open',
      title: nodeOf(project, 64).content.title,
      milestone: null,
    },
  }
  const args = ['add', `https://github.com/${typed}/issues/64`, '--order', '4', '--area', 'release', '--release', '0.2.0']
  const r = run([...args, '--apply'], fakeGh({ project, content }))
  assert.equal(r.code, 0)
  assert.match(r.out, /^Already in the project #64 /)
  assert.deepEqual(writes(r.gh), [])
})

test('add stops before the first write when the plan needs a Wave option that the project does not have', () => {
  // #66 waits for #63 (Wave 2), so it needs Wave 3, and the project has no such option.
  const opts = around66({ blockers: [63] })
  dropOption(opts.project, 'Wave', 'Wave 3')
  dropOption(opts.afterAdd, 'Wave', 'Wave 3')
  const r = run([...addArgs, '--apply'], fakeGh(opts))
  assert.equal(r.code, 1)
  assert.match(r.err, /Wave field has no option "Wave 3" \(needed by #66\)/)
  assert.deepEqual(writes(r.gh), [])
})

test('add prints a warning about a blocker that GitHub cannot resolve once, not once per read', () => {
  // #56 waits for an issue of a private repo. The token cannot read it, and gh exits 1 for it.
  const opts = around66()
  const private999 = { id: 'I_private', number: 999, state: 'OPEN', repository: { nameWithOwner: 'other/private' } }
  for (const data of [opts.project, opts.afterAdd]) nodeOf(data, 56).content.blockedBy.nodes.push(private999)
  const r = run([...addArgs, '--apply'], fakeGh(opts))
  assert.equal(r.code, 0)
  assert.equal(r.err.split('\n').filter(l => /other\/private#999 could not be read/.test(l)).length, 1)
})

test('add with --json prints one JSON document, also for a dry run', () => {
  const dry = JSON.parse(run([...addArgs, '--json'], fakeGh(around66())).out)
  assert.equal(dry.apply, false)
  assert.equal(dry.added.number, 66)
  assert.equal(dry.added.existed, false)
  assert.deepEqual(dry.added.set, { Order: 3, Area: 'tooling', Release: 'Tooling' })
  assert.equal(dry.changes.length, 3)
  assert.deepEqual(
    dry.positions.moves.map(m => [m.ref, m.after]),
    [['#66', '#53']],
  )
  assert.deepEqual([dry.applied, dry.moved], [[], []])
  const done = JSON.parse(run([...addArgs, '--json', '--apply'], fakeGh(around66())).out)
  assert.equal(done.apply, true)
  assert.equal(done.added.itemId, 'PVTI_new66')
  assert.equal(done.applied.length, 3)
  assert.equal(done.moved.length, 1)
  assert.equal(done.positionsLeft, 0)
})

test('usage errors exit 2 and write nothing', () => {
  const cases = [
    [['sync', 'extra'], /sync takes no argument/],
    [['next', 'extra'], /next takes no argument/],
    [['add', '66', '67', '--order', '3', '--area', 'tooling', '--release', 'Tooling'], /add takes one issue or PR, not 2/],
    [['add', 'abc', '--order', '3', '--area', 'tooling', '--release', 'Tooling'], /"abc" is not an issue or PR number or URL/],
  ]
  for (const [args, pattern] of cases) {
    const r = run(args)
    assert.equal(r.code, 2, args.join(' '))
    assert.match(r.err, pattern, args.join(' '))
    assert.deepEqual(writes(r.gh), [], args.join(' '))
  }
})

test('status says so when no draft matches', () => {
  const r = run(['status', 'nothing like it', 'Ready'])
  assert.equal(r.code, 1)
  assert.match(r.err, /No draft item matches "nothing like it"/)
})

test('status --json says what it wrote, and that nothing was written when the value is set', () => {
  const moved = JSON.parse(run(['status', '64', 'In progress', '--json']).out)
  assert.deepEqual([moved.from, moved.to, moved.written], ['Ready', 'In progress', true])
  const same = JSON.parse(run(['status', '64', 'Ready', '--json']).out)
  assert.deepEqual([same.from, same.to, same.written], ['Ready', 'Ready', false])
})

test('--repo sets the repo of the JSON document, and the default is this repo', () => {
  assert.equal(JSON.parse(run(['sync', '--json']).out).repo, REPO)
  assert.equal(JSON.parse(run(['sync', '--json', '--repo', 'acme/lib']).out).repo, 'acme/lib')
})

// The real process: exit codes and the output streams.
function runProcess(args, { path }) {
  return spawnSync(process.execPath, [SYNC, ...args], { encoding: 'utf8', env: { ...process.env, PATH: path } })
}

test('process: --help exits 0', () => {
  const r = runProcess(['--help'], { path: '/nonexistent' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage: sync\.mjs/)
})

test('process: it runs through a symlink, as .claude/skills/project-sync does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'project-sync-link-'))
  symlinkSync(fileURLToPath(new URL('../scripts', import.meta.url)), join(dir, 'scripts'))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'sync.mjs'), '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage: sync\.mjs/)
})

test('process: without gh the exit code is 1 and the message says how to install it', () => {
  const r = runProcess(['sync'], { path: '/nonexistent' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /gh is not installed/)
})

test('process: a gh that rejects the token gives exit 3 and the fallback order on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'project-sync-'))
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "gh: Bad credentials (HTTP 401)" >&2\nexit 1\n')
  chmodSync(join(dir, 'gh'), 0o755)
  const r = runProcess(['sync'], { path: dir })
  assert.equal(r.status, 3)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /Bad credentials/)
  assert.match(r.stderr, /Fallback order/)
})

test('process: the query reaches gh on stdin, as gh api graphql --input - needs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'project-sync-'))
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      'body="$(cat)"',
      'case "$body" in',
      `  *'"query"'*) echo '{"data":{"repositoryOwner":null}}' ;;`,
      '  *) echo "gh: no query on stdin" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(join(dir, 'gh'), 0o755)
  const r = runProcess(['sync'], { path: `${dir}:/usr/bin:/bin` })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /GitHub did not return project 3 of martin-macak/)
})

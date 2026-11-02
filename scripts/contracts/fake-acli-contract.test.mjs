// Contract between the jira tracker and the fake `acli` of the e2e harness (issue #226). The real AcliTool, with the real argv
// builders and parsers, runs against `answer()` of e2e/support/fake-acli.ts. A change of a flag or of a field in the tracker
// that the fake does not follow fails here, in `make verify`, and not only in a local `make e2e`, where the break would show
// as an unsupported call at the pane step.
// It lives here and not in plugins/artifact-tracking/tests, because the kit refuses an import from outside the plugin
// folder. Node runs it with the coverage loader (extensionless imports), as `make test-scripts` does for this folder.
// Run: node --experimental-transform-types --no-warnings --import scripts/coverage/loader.mjs --test scripts/contracts/fake-acli-contract.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answer, fakeAcliSpec } from '../../e2e/support/fake-acli.ts'
import { AcliTool } from '../../plugins/artifact-tracking/trackers/jira/acli-tool'
import { JIRA_KEY } from '../../plugins/artifact-tracking/trackers/jira/urls'

const NOW = 1_000_000
const SITE = 'e2e.atlassian.net'
const SPEC = fakeAcliSpec(SITE, [
  {
    key: 'ABC-1',
    summary: 'The fake work item',
    issueType: 'Task',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    subtasks: [
      { key: 'ABC-2', summary: 'A fake subtask', issueType: 'Sub-task', status: 'To Do', statusCategory: 'new' },
    ],
  },
])

/** An AcliTool whose runner is the fake. `kinds` lists the name of the fake's answer to each call, in order. */
function rig(spec = SPEC) {
  const kinds = []
  const run = async argv => {
    const r = answer(argv.slice(1), spec) // argv[0] is "acli"
    kinds.push(r.call)
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
  return { tool: new AcliTool(run, () => NOW), kinds }
}

const target = key => ({ key: `jira:${SITE}/${key}`, site: SITE, issueKey: key, trackOnly: false, children: [] })

test('the fake acli answers the auth status call of the tool, and the tool reads the site from it', async () => {
  const { tool, kinds } = rig()
  assert.equal(await tool.loadActiveSite(), SITE)
  assert.deepEqual(kinds, ['jira auth status'])
})

test('the fake acli answers the view call of the tool, and the tool reads the item and its subtasks from it', async () => {
  const { tool, kinds } = rig()
  const item = target('ABC-1')
  await tool.refreshItems([item])

  assert.deepEqual(kinds, ['jira auth status', 'jira workitem view'])
  assert.equal(item.summary, 'The fake work item')
  assert.equal(item.issueType, 'Task')
  assert.equal(item.status, 'In Progress')
  assert.equal(item.statusCategory, 'indeterminate')
  assert.equal(item.refreshedAt, NOW)
  assert.deepEqual(
    item.children.map(c => [c.key, c.summary]),
    [['ABC-2', 'A fake subtask']],
  )
})

test('a key the fake does not know gives the item the not-found state, as acli does', async () => {
  const { tool } = rig()
  const item = target('ZZZ-9')
  await tool.refreshItems([item])
  assert.equal(item.error?.kind, 'not-found')
})

test('a fake acli that is not logged in gives the tool no site', async () => {
  const { tool } = rig(fakeAcliSpec(null, []))
  assert.equal(await tool.loadActiveSite(), null)
})

test('the fake accepts and rejects the same keys as JIRA_KEY of the tracker', () => {
  const keys = ['ABC-1', 'A1_B-20', 'AB-0', 'abc-1', 'A-1', '1AB-1', 'ABC-', 'ABC-x', 'ABC1', 'ABC-1 ', '-1']
  for (const key of keys) {
    const accepted = (() => {
      try {
        fakeAcliSpec(SITE, [{ key, summary: 's', issueType: 'Task', status: 'To Do', statusCategory: 'new' }])
        return true
      } catch {
        return false
      }
    })()
    assert.equal(accepted, JIRA_KEY.test(key), `key "${key}"`)
  }
})

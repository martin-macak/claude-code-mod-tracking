// The /track text of the whole pane world, byte for byte (issue #63, L1). The pane draws one table with one header now,
// but the text keeps what it said when every section had its own header: a title line (`title  note`), then one line per
// row. The literal below was captured on `main` before L1. A change here is a change of what `/track` prints.
import { expect, test } from 'claude-code/testing'
import { listText } from '../hooks/pane-text'
import { paneWorld } from './fixtures/pane-world'

const GOLDEN = `Worktrees  git · 2 live · 1 removed · checked 30s ago
  work  main
    feat-x  feat/x
    old-wt  feat/old  removed
    detached-wt  (detached)

Agents  2 running · 2 ended
  ● this session  feat/x  feat-x
    ● explore  feat/y  agent-a94bdd45
      ✓ review  feat/y  agent-a94bdd45
    ● wf_a35565·2 build
    ✗ lint

Pull requests  gh · refreshed 2m ago
  ★ #21  Rework the capture scan  feat/x  open  ✗ checks
  #22  Stacked on the scan  →feat/x  open  … checks
  #23  Old work  feat/old  merged  ✓ checks
  #24  Named and found  feat/z  open  ✓ checks

Jira work items  acli · acme.atlassian.net · refreshed 1m ago
  ISS-1  ↳#21 The epic  Epic  In Progress
    ▽ PROJ-201  ↳#22 The task  Task  To Do
      ▲ PROJ-301  The subtask  Sub-task  Done
    ▽ PROJ-202  The marked task  Task  To Do
  XX-1  XX-1  track-only
  GONE-1  GONE-1  not found

GitHub  gh · refreshed 2m ago
  ★ #5  Issue 5  Issue  open
  ▲ #12  ↳#21 Name the lane  Issue  open
  #9  PR 9  PR  open  … checks
  cli/cli#14640  Crash on exit  Issue  closed
  #7  unresolved: no repo
  #404  Issue  not found
  #15  PR 15  PR  draft

Artifacts  3 artifacts
  Design notes  11111111-1111-4111-8111-111111111111  published
  Old draft  22222222-2222-4222-8222-222222222222  published  deleted
  33333333-3333-4333-8333-333333333333  mentioned

Repos  2 tracked
  acme/web  main  read
  acme/sdk  dev  main, planner  edit

Web links  2 links
  docs.example/a  ↳#21 docs.example/a
  The B page  docs.example/b

Files  3 files
  plan.md  created
  docs/spec.md  edited 2  viewed 1
  README.md  viewed 3  subagent

Processes  docker: daemon not running
  bg  npm run dev  background task  running
  docker  db  docker container  up
  pid  worker  detached process  failed`

test('/track prints the text of every section as it did before the pane drew one table', async () => {
  const t = await paneWorld()
  expect(await listText(t.w.ports, t.m)).toBe(GOLDEN)
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Given, Then, When } from '@cucumber/cucumber'
import { callsOf, type FakePr, fakeGhSpec, isQuiet, type Mergeable } from '../support/fake-gh.ts'
import { FAKE_ORIGIN_NAME, fakeGithubClone, listRefs } from '../support/session.ts'
import { idleMs, waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// The fake gh (support/fake-gh.ts) answers the calls of the github tracker from a spec, so a scenario can show a
// PR state that real GitHub would not give on demand. The default branch of the fake repo is main.
const MERGE_STATUS: Record<Mergeable, string> = { CONFLICTING: 'DIRTY', MERGEABLE: 'CLEAN', UNKNOWN: 'UNKNOWN' }

const isMergeable = (word: string): word is Mergeable => Object.hasOwn(MERGE_STATUS, word)

// Before the session starts. The clone goes on a feature branch, because PR discovery drops the default branch, and its
// origin becomes a local copy that stands for the fake repo: nothing the session runs can reach GitHub.
Given(
  'a fake GitHub repo {string} with the clone on the branch {string}',
  function (this: DemoWorld, ownerRepo: string, branch: string) {
    this.tl.phase('cut')
    this.fakeOriginRefs = listRefs(fakeGithubClone(this.cloneDir, this.config.dir, { branch, ownerRepo }))
    this.setFakeGh(fakeGhSpec(ownerRepo, 'main', []))
  },
)

Given(
  'the fake gh reports PR #{int} {string} from {string} into {string} as {word}',
  function (this: DemoWorld, number: number, title: string, head: string, base: string, mergeable: string) {
    if (this.fakeGh === undefined) throw new Error('fake gh: start with the step "a fake GitHub repo ..."')
    if (!isMergeable(mergeable)) throw new Error(`fake gh: ${mergeable} is not one of ${Object.keys(MERGE_STATUS)}`)
    this.tl.phase('cut')
    const pr: FakePr = {
      number,
      title,
      headRefName: head,
      baseRefName: base,
      mergeable,
      mergeStateStatus: MERGE_STATUS[mergeable],
    }
    this.setFakeGh({ ...this.fakeGh, prs: [...this.fakeGh.prs, pr] })
  },
)

function log(world: DemoWorld) {
  const { logFile } = world.fakeGhFiles
  return existsSync(logFile) ? callsOf(readFileSync(logFile, 'utf8')) : []
}

const describe = (world: DemoWorld) =>
  `fake gh calls: ${
    log(world)
      .map(c => `${c.call} (exit ${c.exit})`)
      .join(', ') || '(none: the fake is not first on the PATH of claude)'
  }\n--- screen ---\n${world.tmux.capture()}`

// A call the mod made and the fake answered with exit 0. This is what shows that claude ran the fake and not the real gh.
Then('the fake gh answered {string}', async function (this: DemoWorld, call: string) {
  this.tl.phase('fast')
  await waitUntil(() => (log(this).some(c => c.call === call && c.exit === 0) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the fake gh to answer "${call}"`,
    last: () => describe(this),
  })
  this.tl.phase('normal')
})

// Issue #165. The mod makes its first calls at the start of a session: the probes, then the PR discovery. A machine under
// load makes the start slow, so a wait of a fixed time after the start does not say that the calls are over. The log is quiet
// when no call came for the given time: the wait counts from the last call, and every call that lands in the meantime starts
// it again. The log starts empty, so it counts as quiet only after the first call (`isQuiet`). The discovery takes the time
// for its stamp before it calls `gh`, so a pane that draws after the quiet time shows an age of at least that time.
When('the fake gh has been quiet for {int} seconds', async function (this: DemoWorld, seconds: number) {
  this.tl.phase('fast')
  await waitUntil(() => (isQuiet(log(this), idleMs(this.fakeGhFiles.logFile), seconds) ? true : undefined), {
    // The quiet time itself is no part of the bound: the wait is over after it, at the earliest.
    timeoutMs: this.config.screenTimeoutMs + seconds * 1000,
    intervalMs: 100,
    what: `the fake gh to answer no call for ${seconds} seconds`,
    last: () => describe(this),
  })
  this.tl.phase('normal')
})

// A call the fake does not know is a call the scenario never planned for: the mod would have asked real GitHub. It can
// also be a call of Claude Code itself (it runs gh for its own PR status), so the message names the argv.
Then('the fake gh answered no unsupported call', function (this: DemoWorld) {
  const calls = log(this)
  const unknown = calls.filter(c => c.call === 'unsupported').map(c => `gh ${c.argv.join(' ')}`)
  if (calls.length === 0) throw new Error(`the fake gh got no call\n${describe(this)}`)
  if (unknown.length > 0)
    throw new Error(`the fake gh got an unsupported call:\n  ${unknown.join('\n  ')}\n${describe(this)}`)
})

// A session that obeys the resolve prompt may push. Its origin is the local copy, so a push lands there, and this step
// sees it. Nothing can land on GitHub.
Then('the fake origin got no push', function (this: DemoWorld) {
  if (this.fakeOriginRefs === undefined) throw new Error('fake origin: start with the step "a fake GitHub repo ..."')
  const now = listRefs(join(this.config.dir, FAKE_ORIGIN_NAME))
  if (now !== this.fakeOriginRefs)
    throw new Error(`the fake origin changed\n--- at start ---\n${this.fakeOriginRefs}\n--- now ---\n${now}`)
})

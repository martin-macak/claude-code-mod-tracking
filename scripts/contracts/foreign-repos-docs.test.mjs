// The README and the KB say which repos the PR lane polls (issue #195). The code is the source: the remote identity pipeline
// of the repos tracker (`parseRemote`, `remoteKey`, `normalizeRemoteUrl`), `githubRefOf` and the config schema. A remote that a
// doc calls "not polled" must give no GitHub repo, one that a doc calls "asked once and held" must give one, and the numbers of
// the config rows must be those of the schema. Prose beyond these anchors has no test: a contract on wording would be overfit.
// The kit has no fs, so this check runs under node in `make test-scripts`.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/foreign-repos-docs.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseRemote } from '../../plugins/artifact-tracking/core/lib/git.ts'
import { REPOS_SCHEMA } from '../../plugins/artifact-tracking/trackers/repos/config.ts'
import { githubRefOf } from '../../plugins/artifact-tracking/trackers/repos/foreign.ts'
import {
  normalizeRemoteUrl,
  REMOTE_ALIASES,
  remoteKey,
} from '../../plugins/artifact-tracking/trackers/repos/identity.ts'

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const README = read('../../plugins/artifact-tracking/README.md')
const KB = read('../../docs/knowledge-base/claude-code-auto-tracking/pull-requests.md')

/** The one line of `text` that starts with `prefix`. */
function lineOf(text, prefix) {
  const lines = text.split('\n').filter(l => l.startsWith(prefix))
  assert.equal(lines.length, 1, `exactly one line starts with ${prefix}`)
  return lines[0]
}

/** What the repos tracker does with a remote: the identity pipeline of a visit, then the GitHub test of the poll. */
function polled(remote) {
  const parsed = parseRemote(remote, REMOTE_ALIASES)
  const id = parsed ? { key: remoteKey(parsed), name: `${parsed.owner}/${parsed.repo}` } : normalizeRemoteUrl(remote)
  return githubRefOf(id) !== null
}

// The remotes that no poll is made for, and the ones that are polled, asked once for their host and held when `gh` refuses it.
const NOT_POLLED = ['git@gitlab.com:grp/sub/r.git', 'git@example.org:8080/o/r', 'file:///x/y', '/x/y/z.git']
const HELD = ['git@github-work:o/r', 'git@gitlab.com:o/r', 'https://ghe.corp:8443/o/r.git']

const readmeBullet = lineOf(README, '- Not polled:')
const kbBullet = lineOf(KB, '- Only a repo with a `remote:<host>/<owner>/<repo>` key')

/** A bullet in two parts: what is not polled, then the sentence about the remotes that are asked once and held. */
function partsOf(line) {
  const i = line.indexOf('A remote of another forge')
  assert.ok(i > 0, `the bullet has the sentence about a remote of another forge: ${line.slice(0, 60)}`)
  const [no, held] = [line.slice(0, i), line.slice(i)]
  assert.ok(held.includes('asked once'), `the sentence says that a remote is asked once: ${held}`)
  return [no, held]
}

test('the code: the remotes of the docs give a GitHub repo or none, as the docs say', () => {
  for (const remote of NOT_POLLED) assert.equal(polled(remote), false, `${remote} is not polled`)
  for (const remote of HELD)
    assert.equal(polled(remote), true, `${remote} is polled, and held when gh refuses its host`)
})

for (const [name, line] of [
  ['README', readmeBullet],
  ['KB', kbBullet],
]) {
  test(`the ${name} lists as not polled only remotes that give no GitHub repo, and as held those that give one`, () => {
    const [no, held] = partsOf(line)
    // An example remote in a code span (`user@host:path`, a URL) must give what the part says.
    const examples = part => [...part.matchAll(/`([^`]*(?:@|:\/\/)[^`]*)`/g)].map(m => m[1])
    for (const remote of examples(no)) assert.equal(polled(remote), false, `${name}: "${remote}" is not polled`)
    for (const remote of examples(held)) assert.equal(polled(remote), true, `${name}: "${remote}" is polled`)
    // The classes that the code polls: an ssh host alias and a URL with a port. Neither is in the "not polled" part.
    assert.ok(!/ssh (host )?alias/i.test(no), `${name}: an ssh alias is polled, not "not polled": ${no}`)
    assert.ok(!/\ba port\b|\bwith a port\b/i.test(no), `${name}: a remote with a port is polled: ${no}`)
    for (const word of ['ssh', 'port', 'gitlab.com/o/r'])
      assert.ok(held.includes(word), `${name}: the held part names ${word}: ${held}`)
    assert.ok(held.includes('pollRepos'), `${name}: a held repo still takes one of the pollRepos slots`)
  })
}

test('the README rows and the KB limit give the default, the min and the max of the schema', () => {
  for (const key of ['pollRepos', 'maxRepoRoots']) {
    const rule = REPOS_SCHEMA[key]
    assert.equal(rule.kind, 'int')
    const row = lineOf(README, `| \`trackers.repos.${key}\` |`)
    const cells = row.split('|').map(c => c.trim())
    assert.deepEqual(cells.slice(2, 5), [rule.def, rule.min, rule.max].map(String), `README row of ${key}: ${row}`)
  }
  assert.ok(kbBullet.includes(`\`trackers.repos.pollRepos\` (${REPOS_SCHEMA.pollRepos.def})`), kbBullet)
})

test('the README and the KB say that the lane covers the branches that the session proved in other repos', () => {
  assert.ok(README.includes('a branch that the session proved in another repo'), 'the README Pull requests row says it')
  assert.ok(KB.includes('\n## 5. Branches of other repos\n'), 'the KB has the section')
})

test('the docs name no flag of /track refresh: it waits for the poll, not for the PR step that a new fact starts', () => {
  for (const [name, text] of [
    ['README', README],
    ['KB', KB],
  ])
    assert.ok(!text.includes('refresh --wait'), `${name} names a flag that /track refresh does not have`)
  const bullet = lineOf(README, '- A repo is polled at each tick of the lane')
  assert.ok(bullet.includes('waits for the poll'), bullet)
  assert.ok(bullet.includes('does not wait for the PR step'), bullet)
})

test('the docs say that a toplevel that is gone keeps the branch it had at the last visit, not the last branch it had', () => {
  const readme = lineOf(README, 'The session proves a branch in another repo by standing on it')
  assert.ok(readme.includes('keeps the branch it had at the last visit'), readme)
  assert.ok(!README.includes('keeps its last branch'), 'the README says the branch of the last visit')
  assert.ok(!KB.includes('keeps its last branch'), 'the KB says the branch of the last visit')
  assert.ok(KB.includes('keeps the branch it had at the last visit'), 'the KB says the branch of the last visit')
})

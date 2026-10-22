import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  claudeCommand,
  countLines,
  DEMO_SYSTEM_PROMPT,
  fakeGithubClone,
  type LaunchSpec,
  listRefs,
  prepareClone,
  READY_MARKERS,
  shellQuote,
  stopHookSettings,
  TOOLS_SYSTEM_PROMPT,
  trustKey,
  waitForTurnEnd,
} from '../support/session.ts'

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

// The argv that claudeCommand hands to claude, one word per element: the shell prints it instead of running claude.
const argvOf = (spec: Partial<LaunchSpec>) =>
  execFileSync(
    '/bin/sh',
    [
      '-c',
      claudeCommand({ pluginDir: '/p', model: 'haiku', signalFile: '/s', ...spec }).replace(
        /^'claude'/,
        "printf '%s\\n'",
      ),
    ],
    { encoding: 'utf8' },
  )
    .trimEnd()
    .split('\n')

test('READY_MARKERS match the idle prompt line, which uses a no-break space, but not dialog options', () => {
  const ready = (screen: string) => READY_MARKERS.some(re => re.test(screen))
  assert.ok(ready('───\n❯\u00a0Try "how do I log an error?"\n───'))
  assert.equal(ready(' ❯ No, exit\n   Yes, I trust this folder'), false)
})

test('trustKey moves to "Yes" first, then confirms, and ignores other screens', () => {
  const dialog = (chosen: 'No' | 'Yes') =>
    ` Quick safety check\n ${chosen === 'No' ? '❯' : ' '} No, exit\n ${chosen === 'Yes' ? '❯' : ' '} Yes, I trust this folder\n`
  assert.equal(trustKey(dialog('No')), 'Down')
  assert.equal(trustKey(dialog('Yes')), 'Enter')
  assert.equal(trustKey(dialog('Yes').replace('❯ ', '❯\u00a0')), 'Enter')
  assert.equal(trustKey('❯ Try "how does <filepath> work?"'), undefined)
})

test('shellQuote survives single quotes', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote("a 'b' $c")}`], { encoding: 'utf8' }), "a 'b' $c")
})

test('claudeCommand gives claude the exact argv, prompt last', () => {
  const argv = argvOf({
    pluginDir: '/p q/mod',
    signalFile: '/s t/signal',
    prompt: "Say 'hi'; then stop",
  })
  assert.deepEqual(argv.slice(0, 6), ['--setting-sources', 'project', '--plugin-dir', '/p q/mod', '--model', 'haiku'])
  assert.equal(argv.at(-1), "Say 'hi'; then stop")
  assert.ok(argv.includes('--settings'))
  assert.ok(argv.includes('--append-system-prompt'))
})

test('claudeCommand with tools: the tools system prompt and an allow list, prompt still last', () => {
  const argv = argvOf({ prompt: 'go', tools: ['Read', 'Artifact'] })
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], TOOLS_SYSTEM_PROMPT)
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Artifact')
  assert.ok(argv[argv.indexOf('--allowedTools') + 2]?.startsWith('--')) // a variadic flag must not take the prompt
  assert.equal(argv.at(-1), 'go')
  const demo = claudeCommand({ pluginDir: '/p', model: 'haiku', signalFile: '/s' })
  assert.ok(demo.includes(shellQuote(DEMO_SYSTEM_PROMPT)))
  assert.ok(!demo.includes('--allowedTools'))
})

// Issue #215. The demo session is tool-free by the flags, not by a sentence of the system prompt: a prompt that asks
// for git or gh work (the resolve key) wins over that sentence now and then, and a session that auto-approves
// commands (the permission mode of the developer's own config) runs them with no dialog. `--tools ''` drops the
// built-in tools; `--strict-mcp-config` drops the MCP servers of the account, which the first flag leaves on.
test('claudeCommand without tools turns every built-in tool and MCP server off, and with tools it does not', () => {
  const demo = argvOf({ prompt: 'go' })
  const at = demo.indexOf('--tools')
  assert.notEqual(at, -1, 'the demo session passes --tools')
  assert.equal(demo[at + 1], '') // the empty list: no tool at all
  assert.ok(demo[at + 2]?.startsWith('--')) // a variadic flag must not take the prompt
  assert.equal(demo.at(-1), 'go')
  assert.ok(demo.includes('--strict-mcp-config'), 'the demo session passes --strict-mcp-config')
  const withTools = argvOf({ tools: ['Read'] })
  assert.ok(!withTools.includes('--tools')) // a scenario that gives tools keeps the default set
  assert.ok(!withTools.includes('--strict-mcp-config')) // and the MCP servers of the account
})

test('claudeCommand with env runs claude through env, variables first', () => {
  const spec = { pluginDir: '/p', model: 'haiku', signalFile: '/s', env: { CLAUDE_TRACKER_CONFIG_DIR: '/t d/cfg' } }
  const command = claudeCommand(spec)
  assert.ok(command.startsWith("'env' 'CLAUDE_TRACKER_CONFIG_DIR=/t d/cfg' 'claude' "))
  const printed = execFileSync('/bin/sh', ['-c', command.replace(/^'env'/, "printf '%s\\n'")], { encoding: 'utf8' })
  const argv = printed.trimEnd().split('\n')
  assert.deepEqual(argv.slice(0, 2), ['CLAUDE_TRACKER_CONFIG_DIR=/t d/cfg', 'claude'])
  assert.ok(argv.includes('--plugin-dir'))
})

test('claudeCommand with an empty env is the plain command', () => {
  const spec = { pluginDir: '/p', model: 'haiku', signalFile: '/s', prompt: 'go' }
  assert.equal(claudeCommand({ ...spec, env: {} }), claudeCommand(spec))
  assert.ok(claudeCommand(spec).startsWith("'claude' "))
})

test('claudeCommand refuses a prompt that looks like a flag', () => {
  assert.throws(() => claudeCommand({ pluginDir: '/p', model: 'm', signalFile: '/s', prompt: '-x' }), /flag/)
})

test('the Stop hook command appends a line to a signal path with spaces', () => {
  const dir = join(tempDir('sig-'), 'a b')
  mkdirSync(dir)
  const signal = join(dir, 'signal')
  const settings = JSON.parse(stopHookSettings(signal))
  const command: string = settings.hooks.Stop[0].hooks[0].command
  execFileSync('/bin/sh', ['-c', command])
  execFileSync('/bin/sh', ['-c', command])
  assert.equal(countLines(signal), 2)
})

test('countLines is 0 for a missing file', () => {
  assert.equal(countLines(join(tempDir('cl-'), 'none')), 0)
})

test('waitForTurnEnd resolves when the signal file gains a line', async () => {
  const signal = join(tempDir('turn-'), 'signal')
  writeFileSync(signal, 'stop\n')
  setTimeout(() => appendFileSync(signal, 'stop\n'), 30)
  await waitForTurnEnd(signal, 1, 2000)
})

test('waitForTurnEnd times out with the last screen', async () => {
  const signal = join(tempDir('turn-'), 'signal')
  await assert.rejects(
    waitForTurnEnd(signal, 0, 50, () => 'SCREEN'),
    /turn end[\s\S]*SCREEN/,
  )
})

test('prepareClone checks out HEAD on main with the real origin', () => {
  const repo = tempDir('repo-')
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'feature'])
  writeFileSync(join(repo, 'f'), 'x')
  git(['add', 'f'])
  git(['commit', '-q', '-m', 'c'])
  git(['remote', 'add', 'origin', 'git@github.com:o/r.git'])
  const head = git(['rev-parse', 'HEAD'])

  const parent = tempDir('parent-')
  const clone = prepareClone(repo, parent)
  assert.equal(clone, join(parent, 'claude-code-mod-tracking'))
  assert.equal(git(['rev-parse', 'HEAD'], clone), head)
  assert.equal(git(['branch', '--show-current'], clone), 'main')
  assert.equal(git(['remote', 'get-url', 'origin'], clone), 'git@github.com:o/r.git')
  assert.equal(readFileSync(join(clone, 'f'), 'utf8'), 'x')

  // A second call replaces the old clone.
  writeFileSync(join(clone, 'junk'), 'y')
  prepareClone(repo, parent)
  assert.throws(() => readFileSync(join(clone, 'junk')))
})

test('prepareClone works from a linked worktree on an unpushed branch', () => {
  // The harness runs from .claude/worktrees/<name>, which has a .git file, not a folder.
  const repo = tempDir('repo-')
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'f'), 'x')
  git(['add', 'f'])
  git(['commit', '-q', '-m', 'c'])
  git(['remote', 'add', 'origin', 'git@github.com:o/r.git'])
  const worktree = join(tempDir('wt-'), 'w')
  git(['worktree', 'add', '-q', '-b', 'feat/x', worktree])
  writeFileSync(join(worktree, 'g'), 'y')
  git(['add', 'g'], worktree)
  git(['commit', '-q', '-m', 'd'], worktree)
  const head = git(['rev-parse', 'HEAD'], worktree)

  const clone = prepareClone(worktree, tempDir('parent-'))
  assert.equal(git(['rev-parse', 'HEAD'], clone), head)
  assert.equal(readFileSync(join(clone, 'g'), 'utf8'), 'y')
})

test('fakeGithubClone puts the clone on a branch, with an origin that names a fake repo and is a local copy', () => {
  const repo = tempDir('repo-')
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'f'), 'x')
  git(['add', 'f'])
  git(['commit', '-q', '-m', 'c'])
  git(['remote', 'add', 'origin', 'git@github.com:real/repo.git'])
  const parent = tempDir('parent-')
  const clone = prepareClone(repo, parent)

  const bare = fakeGithubClone(clone, parent, { branch: 'feat/fake-conflict', ownerRepo: 'e2e-owner/e2e-repo' })
  assert.equal(bare, join(parent, 'fake-origin.git'))
  assert.equal(git(['branch', '--show-current'], clone), 'feat/fake-conflict')
  // The config keeps the fake GitHub URL. `get-url` and every fetch or push go through the local copy.
  assert.equal(git(['config', '--get', 'remote.origin.url'], clone), 'https://github.com/e2e-owner/e2e-repo.git')
  assert.equal(git(['remote', 'get-url', 'origin'], clone), bare)
  const refs = git(['ls-remote', 'origin'], clone)
  assert.match(refs, /refs\/heads\/main$/m)
  assert.match(refs, /refs\/heads\/feat\/fake-conflict$/m)
  assert.equal(git(['rev-parse', 'HEAD'], clone), git(['rev-parse', 'refs/heads/feat/fake-conflict'], bare))

  // A push goes to the local copy. Neither the real remote nor the source repo sees it.
  const before = listRefs(bare)
  assert.match(before, /^refs\/heads\/feat\/fake-conflict [0-9a-f]{40}$/m)
  assert.equal(listRefs(bare), before)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/pushed'], clone)
  assert.notEqual(listRefs(bare), before)
  assert.match(listRefs(bare), /^refs\/heads\/pushed /m)
  assert.equal(git(['rev-parse', 'refs/heads/pushed'], bare), git(['rev-parse', 'HEAD'], clone))
  assert.throws(() => git(['rev-parse', '--verify', 'refs/heads/pushed'], repo))

  // A second call replaces the old copy.
  fakeGithubClone(prepareClone(repo, parent), parent, { branch: 'feat/fake-conflict', ownerRepo: 'e2e-owner/e2e-repo' })
  assert.throws(() => git(['rev-parse', '--verify', 'refs/heads/pushed'], bare))
})

test('fakeGithubClone refuses an owner/repo that is not two plain names', () => {
  for (const bad of ['no-slash', 'a/b/c', '/b', 'a/', 'a b/c', 'a/b;c'])
    assert.throws(() => fakeGithubClone('/x', '/y', { branch: 'b', ownerRepo: bad }), /owner\/repo/)
})

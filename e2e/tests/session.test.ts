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
  prepareClone,
  READY_MARKERS,
  shellQuote,
  stopHookSettings,
  TOOLS_SYSTEM_PROMPT,
  trustKey,
  waitForTurnEnd,
} from '../support/session.ts'

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

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
  const spec = { pluginDir: '/p q/mod', model: 'haiku', signalFile: '/s t/signal', prompt: "Say 'hi'; then stop" }
  const printed = execFileSync('/bin/sh', ['-c', claudeCommand(spec).replace(/^'claude'/, "printf '%s\\n'")], {
    encoding: 'utf8',
  })
  const argv = printed.trimEnd().split('\n')
  assert.deepEqual(argv.slice(0, 6), ['--setting-sources', 'project', '--plugin-dir', '/p q/mod', '--model', 'haiku'])
  assert.equal(argv.at(-1), "Say 'hi'; then stop")
  assert.ok(argv.includes('--settings'))
  assert.ok(argv.includes('--append-system-prompt'))
})

test('claudeCommand with tools: the tools system prompt and an allow list, prompt still last', () => {
  const spec = { pluginDir: '/p', model: 'haiku', signalFile: '/s', prompt: 'go', tools: ['Read', 'Artifact'] }
  const printed = execFileSync('/bin/sh', ['-c', claudeCommand(spec).replace(/^'claude'/, "printf '%s\\n'")], {
    encoding: 'utf8',
  })
  const argv = printed.trimEnd().split('\n')
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], TOOLS_SYSTEM_PROMPT)
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Artifact')
  assert.ok(argv[argv.indexOf('--allowedTools') + 2]?.startsWith('--')) // a variadic flag must not take the prompt
  assert.equal(argv.at(-1), 'go')
  const demo = claudeCommand({ pluginDir: '/p', model: 'haiku', signalFile: '/s' })
  assert.ok(demo.includes(shellQuote(DEMO_SYSTEM_PROMPT)))
  assert.ok(!demo.includes('--allowedTools'))
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

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import {
  claudeCommand,
  countLines,
  DEMO_SYSTEM_PROMPT,
  FOREIGN_README,
  fakeForeignRepo,
  fakeGithubClone,
  type LaunchSpec,
  launchCommand,
  listRefs,
  pinOriginHead,
  prepareClone,
  promptInBox,
  READY_MARKERS,
  resendBudget,
  shellQuote,
  stopHookSettings,
  submitPrompt,
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

test('claudeCommand names the permission mode only when the spec has one, before --settings', () => {
  assert.ok(!argvOf({ tools: ['Bash'] }).includes('--permission-mode'))
  const argv = argvOf({ tools: ['Agent', 'Bash'], permissionMode: 'default', prompt: 'go' })
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'default')
  assert.ok(argv.indexOf('--permission-mode') < argv.indexOf('--settings'))
  assert.equal(argv.at(-1), 'go')
})

test('claudeCommand resumes the last conversation of the folder only when the spec says so, before --settings (issue #247)', () => {
  assert.ok(!argvOf({ tools: ['Bash'] }).includes('--continue'))
  const argv = argvOf({ tools: ['Bash'], resume: true })
  assert.equal(argv.filter(a => a === '--continue').length, 1)
  assert.ok(argv.indexOf('--continue') < argv.indexOf('--settings'))
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

test('claudeCommand gives each extra plugin its own --plugin-dir after the mod', () => {
  const spec = { pluginDir: '/p', model: 'haiku', signalFile: '/s', extraPluginDirs: ['/probe a', '/probe b'] }
  const printed = execFileSync('/bin/sh', ['-c', claudeCommand(spec).replace(/^'claude'/, "printf '%s\\n'")], {
    encoding: 'utf8',
  })
  const argv = printed.trimEnd().split('\n')
  assert.deepEqual(argv.slice(0, 8), [
    '--setting-sources',
    'project',
    '--plugin-dir',
    '/p',
    '--plugin-dir',
    '/probe a',
    '--plugin-dir',
    '/probe b',
  ])
  assert.equal(
    claudeCommand({ ...spec, extraPluginDirs: [] }),
    claudeCommand({ pluginDir: '/p', model: 'haiku', signalFile: '/s' }),
  )
})

// Issue #193. The debug file holds what the mod wrote with `$.ui.log(text, { to: 'debug' })`, so a scenario can read it.
// A session with no debug file has none of the flag: the other scenarios keep their launch.
test('claudeCommand with a debug file passes --debug-file and its path, and without one passes no flag for it', () => {
  const argv = argvOf({ prompt: 'go', debugFile: '/o u/debug.log' })
  assert.equal(argv[argv.indexOf('--debug-file') + 1], '/o u/debug.log')
  assert.equal(argv.at(-1), 'go') // the prompt stays last
  assert.ok(!argvOf({ prompt: 'go' }).includes('--debug-file'))
})

// `launchClaude` once rebuilt the spec by hand and dropped a field it did not know (the debug file of issue #193 never reached
// claude: the log stayed empty in two live runs). `launchCommand` is what it runs: every field of the launch reaches claude.
test('launchCommand hands claude every field of the launch: probes, debug file, tools, env, unset and the prompt', () => {
  const ctx = {
    tmux: undefined as never,
    timeoutMs: 1,
    pluginDir: '/p',
    extraPluginDirs: ['/probe'],
    debugFile: '/o/debug.log',
    model: 'haiku',
    signalFile: '/s',
    tools: ['Read'],
    env: { A: '1' },
    unset: ['CLAUDECODE'],
  }
  const { tmux: _tmux, timeoutMs: _timeoutMs, ...spec } = ctx
  assert.equal(launchCommand(ctx, 'go'), claudeCommand({ ...spec, prompt: 'go' }))
  assert.ok(launchCommand(ctx, 'go').includes(shellQuote('/o/debug.log')))
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

test('claudeCommand with unset removes the variables for claude only, before it sets the others', () => {
  const spec = {
    pluginDir: '/p',
    model: 'haiku',
    signalFile: '/s',
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
    unset: ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'],
  }
  const command = claudeCommand(spec)
  assert.ok(
    command.startsWith(
      "'env' '-u' 'CLAUDECODE' '-u' 'CLAUDE_CODE_SESSION_ID' 'ANTHROPIC_BASE_URL=http://127.0.0.1:1' 'claude' ",
    ),
  )
  const printed = execFileSync('/bin/sh', ['-c', command.replace(/^'env'/, "printf '%s\\n'")], { encoding: 'utf8' })
  assert.deepEqual(printed.trimEnd().split('\n').slice(0, 6), [
    '-u',
    'CLAUDECODE',
    '-u',
    'CLAUDE_CODE_SESSION_ID',
    'ANTHROPIC_BASE_URL=http://127.0.0.1:1',
    'claude',
  ])
  const onlyUnset = claudeCommand({ pluginDir: '/p', model: 'haiku', signalFile: '/s', unset: ['CLAUDECODE'] })
  assert.ok(onlyUnset.startsWith("'env' '-u' 'CLAUDECODE' 'claude' "))
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

// Issue #269. The first Enter can leave the box and the text can come back, with no turn started. The wait for the turn end
// presses Enter again while the typed text sits in the box.
test('waitForTurnEnd presses Enter again while the typed text is back in the box, and resolves at the turn end', async () => {
  const signal = join(tempDir('turn-'), 'signal')
  let enters = 0
  await waitForTurnEnd(signal, 0, 2000, undefined, {
    prompt: 'Note https://a.example/1 for later.',
    io: {
      capture: () => STUCK_SCREEN,
      key: name => {
        assert.equal(name, 'Enter')
        if (++enters === 2) appendFileSync(signal, 'stop\n')
      },
    },
    retryMs: 5,
    intervalMs: 1,
  })
  assert.equal(enters, 2)
})

// Causal, no timer race: the signal comes from inside the 6th capture, so the box was empty for several polls past the retry window.
test('waitForTurnEnd presses no Enter while the box is empty', async () => {
  const signal = join(tempDir('turn-'), 'signal')
  let enters = 0
  let captures = 0
  await waitForTurnEnd(signal, 0, 2000, undefined, {
    prompt: 'Note https://a.example/1 for later.',
    io: {
      capture: () => {
        if (++captures === 6) appendFileSync(signal, 'stop\n')
        return SENT_SCREEN
      },
      key: () => void enters++,
    },
    retryMs: 0,
    intervalMs: 1,
  })
  assert.ok(captures >= 6)
  assert.equal(enters, 0)
})

// The first window starts at the call: the retry window is longer than the wait, so no key is pressed. A stale clock is pinned by the next test.
test('waitForTurnEnd presses no Enter before the retry window has passed', async () => {
  const signal = join(tempDir('turn-'), 'signal')
  let enters = 0
  await assert.rejects(
    waitForTurnEnd(signal, 0, 50, () => STUCK_SCREEN, {
      prompt: 'Note https://a.example/1 for later.',
      io: { capture: () => STUCK_SCREEN, key: () => void enters++ },
      retryMs: 60000,
      intervalMs: 1,
    }),
    /turn end/,
  )
  assert.equal(enters, 0)
})

/**
 * A clock that only the polls move: each `capture` adds `stepMs`, whatever the load. A retry-window test counts presses against
 * this clock, so a slow event loop cannot change the count.
 */
function fakeClock(stepMs: number): { capture: () => string; restore: () => void } {
  let now = 1_000_000
  const spy = mock.method(Date, 'now', () => now)
  return {
    capture: () => {
      now += stepMs
      return STUCK_SCREEN
    },
    restore: () => spy.mock.restore(),
  }
}

// A stale clock (never restarted after a press) presses on every poll once the first window has passed. The fake clock moves 10 ms
// per poll: a 30 ms window over a 120 ms wait gives 3 or 4 presses, a stale clock gives about 9.
test('waitForTurnEnd presses Enter at most once per retry window', async () => {
  const signal = join(tempDir('turn-'), 'signal')
  const clock = fakeClock(10)
  let enters = 0
  try {
    await assert.rejects(
      waitForTurnEnd(signal, 0, 120, () => STUCK_SCREEN, {
        prompt: 'Note https://a.example/1 for later.',
        io: { capture: clock.capture, key: () => void enters++ },
        retryMs: 30,
        intervalMs: 1,
      }),
      /turn end/,
    )
  } finally {
    clock.restore()
  }
  assert.ok(enters >= 2 && enters <= 120 / 30 + 1, `pressed ${enters} times`)
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

test('pinOriginHead gives a clone of a source that is detached an origin/HEAD at its HEAD (m1 of the review of #289)', () => {
  const repo = tempDir('repo-')
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'f'), 'x')
  git(['add', 'f'])
  git(['commit', '-q', '-m', 'c'])
  writeFileSync(join(repo, 'f'), 'y')
  git(['commit', '-q', '-am', 'd'])
  git(['remote', 'add', 'origin', 'git@github.com:o/r.git'])
  git(['checkout', '-q', '--detach', 'HEAD~1']) // a checkout in the middle of a rebase or a bisect: on no branch, below the tip of main
  const head = git(['rev-parse', 'HEAD'])

  const clone = prepareClone(repo, tempDir('parent-'))
  const originHead = () => {
    try {
      return git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], clone)
    } catch {
      return ''
    }
  }
  assert.equal(originHead(), '', 'git sets no origin/HEAD for a source that is detached below the tip of main')
  pinOriginHead(clone)
  assert.equal(originHead(), 'refs/remotes/origin/main')
  assert.equal(
    git(['merge-base', 'HEAD', 'origin/HEAD'], clone),
    head,
    'the base of a diff in the clone is its own HEAD',
  )
  pinOriginHead(clone) // a second call changes nothing
  assert.equal(originHead(), 'refs/remotes/origin/main')
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

test('fakeForeignRepo makes a repo on a feature branch whose origin is the GitHub URL, and whose push goes to a local copy (issue #195)', () => {
  const base = realpathSync(tempDir('foreign-')) // a tmpdir is a link on a Mac: git prints the real path
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const made = fakeForeignRepo(base, { branch: 'feat/second', ownerRepo: 'e2e-owner/second' })
  assert.equal(made.dir, join(base, 'second'))
  assert.equal(made.readme, join(base, 'second', 'README.md'))
  assert.equal(readFileSync(made.readme, 'utf8'), FOREIGN_README)
  assert.equal(git(['branch', '--show-current'], made.dir), 'feat/second')
  assert.equal(git(['rev-parse', '--show-toplevel'], made.dir), made.dir)
  // The repos tracker reads the repo from `git remote get-url origin`: it must say GitHub, as a real clone does. A fetch
  // would go to GitHub, which is why the scenario never fetches; a push goes to the local copy.
  assert.equal(git(['config', '--get', 'remote.origin.url'], made.dir), 'https://github.com/e2e-owner/second.git')
  // A global rewrite of the machine may turn https into ssh, which the repos tracker reads as GitHub all the same.
  assert.match(
    git(['remote', 'get-url', 'origin'], made.dir),
    /^(https:\/\/|ssh:\/\/git@)github\.com\/e2e-owner\/second\.git$/,
  )
  assert.equal(git(['remote', 'get-url', '--push', 'origin'], made.dir), made.bare)
  assert.equal(made.bare, join(base, 'second.git'))
  git(['push', '-q', 'origin', 'HEAD:refs/heads/pushed'], made.dir)
  assert.match(listRefs(made.bare), /^refs\/heads\/pushed /m)
  assert.match(listRefs(made.bare), /^refs\/heads\/feat\/second /m)
  // A second call on the same folder starts afresh.
  fakeForeignRepo(base, { branch: 'feat/other', ownerRepo: 'e2e-owner/second' })
  assert.equal(git(['branch', '--show-current'], made.dir), 'feat/other')
  assert.doesNotMatch(listRefs(made.bare), /pushed/)
})

test('fakeForeignRepo refuses an owner/repo that is not two plain names', () => {
  for (const bad of ['no-slash', 'a/b/c', '/b', 'a/', 'a b/c', 'a/b;c'])
    assert.throws(() => fakeForeignRepo('/x', { branch: 'b', ownerRepo: bad }), /owner\/repo/)
})

test('fakeGithubClone refuses an owner/repo that is not two plain names', () => {
  for (const bad of ['no-slash', 'a/b/c', '/b', 'a/', 'a b/c', 'a/b;c'])
    assert.throws(() => fakeGithubClone('/x', '/y', { branch: 'b', ownerRepo: bad }), /owner\/repo/)
})

// Issue #269. A session that shows the prompt marker can still drop the Enter of a typed prompt, and the text stays in the box.
const BOX = '────\n❯\u00a0'
const SENT_SCREEN = '❯\u00a0Note https://a.example/1 for later.\n⏺ ok\n' + BOX + '\n────'
const STUCK_SCREEN = '▐▛███▛█   Claude Code\n────\n❯\u00a0Note https://a.example/1 for later.\n────\n  ⏵⏵ auto mode on'

test('promptInBox is true while the typed text sits in the prompt box, and false once the box is empty', () => {
  assert.equal(promptInBox(STUCK_SCREEN, 'Note https://a.example/1 for later.'), true)
  assert.equal(promptInBox(SENT_SCREEN, 'Note https://a.example/1 for later.'), false)
  assert.equal(promptInBox('no prompt at all', 'x'), false)
  // A short prompt matches by its whole text; a long one that wraps in the box matches by its first 24 characters.
  assert.equal(promptInBox('────\n❯\u00a0Note\n────', 'Note'), true)
  const long = 'Note https://a.example/1 for later, and then a second sentence that wraps.'
  assert.equal(promptInBox('────\n❯\u00a0Note https://a.example/1 for later, and\n  then a second\n────', long), true)
  // An empty prompt is never "in the box": it would press Enter on any box.
  assert.equal(promptInBox(STUCK_SCREEN, ''), false)
  assert.equal(promptInBox(SENT_SCREEN, '  '), false)
})

test('submitPrompt presses Enter again while the text stays in the box, and stops when the box empties', async () => {
  const text = 'Note https://a.example/1 for later.'
  let enters = 0
  await submitPrompt(
    {
      capture: () => (enters >= 3 ? SENT_SCREEN : STUCK_SCREEN),
      key: name => {
        assert.equal(name, 'Enter')
        enters++
      },
    },
    text,
    { timeoutMs: 1000, intervalMs: 1, retryMs: 2 },
  )
  assert.equal(enters, 3)
})

test('submitPrompt presses Enter once when the first Enter works', async () => {
  let enters = 0
  await submitPrompt({ capture: () => SENT_SCREEN, key: () => void enters++ }, 'Note https://a.example/1 for later.', {
    timeoutMs: 1000,
    intervalMs: 1,
    retryMs: 2,
  })
  assert.equal(enters, 1)
})

test('submitPrompt presses Enter once, not on every poll, inside the retry window', async () => {
  let enters = 0
  await assert.rejects(
    submitPrompt({ capture: () => STUCK_SCREEN, key: () => void enters++ }, 'Note https://a.example/1 for later.', {
      timeoutMs: 40,
      intervalMs: 1,
      retryMs: 60000,
    }),
    /the prompt to leave the box/,
  )
  assert.equal(enters, 1)
})

// Same bound for submitPrompt: a stale clock presses on every poll after the first window.
test('submitPrompt presses Enter at most once per retry window', async () => {
  const clock = fakeClock(10)
  let enters = 0
  try {
    await assert.rejects(
      submitPrompt({ capture: clock.capture, key: () => void enters++ }, 'Note https://a.example/1 for later.', {
        timeoutMs: 120,
        intervalMs: 1,
        retryMs: 30,
      }),
      /prompt not sent/,
    )
  } finally {
    clock.restore()
  }
  assert.ok(enters >= 3 && enters <= 120 / 30 + 1, `pressed ${enters} times`)
})

// A `Tmux` instance reads `this` in `capture`: the timeout error must call it as a method, not detached.
test('submitPrompt keeps the screen in the error when capture is a method that reads this', async () => {
  class Pane {
    screen = STUCK_SCREEN
    capture(): string {
      return this.screen
    }
    key(): void {}
  }
  await assert.rejects(
    submitPrompt(new Pane(), 'Note https://a.example/1 for later.', { timeoutMs: 5000, intervalMs: 1, retryMs: 5 }),
    /prompt not sent[\s\S]*Claude Code/,
  )
})

test('submitPrompt fails with the screen when the text never leaves the box', async () => {
  await assert.rejects(
    submitPrompt({ capture: () => STUCK_SCREEN, key: () => {} }, 'Note https://a.example/1 for later.', {
      timeoutMs: 5000,
      intervalMs: 1,
      retryMs: 5,
    }),
    /prompt not sent[\s\S]*Claude Code/,
  )
})

// Issue #379. A long prompt (the 40 links of pane.feature:403) wraps over several lines, or the composer collapses it into a
// placeholder. Both forms are an unsent prompt, so the harness must see the text in the box and press Enter again.
const LONG_PROMPT = `Note ${Array.from({ length: 40 }, (_, n) => `https://a${n + 1}.io/x`).join(', ')} for later. Reply ok.`
const WRAPPED_SCREEN = `────\n❯ ${LONG_PROMPT.slice(0, 90)}\n  ${LONG_PROMPT.slice(90, 180)}\n  ${LONG_PROMPT.slice(180, 270)}\n────\n  ⏵⏵ auto mode on`
const PLACEHOLDER_SCREEN = '────\n❯ [Pasted text #1 +1 lines]\n────\n  ⏵⏵ auto mode on'
const PLACEHOLDER_SENT_SCREEN = '❯ [Pasted text #1 +1 lines]\n⏺ ok\n' + BOX + '\n────'

// Keys lost on the way: the first characters never reached the box, so the start of the text is not there.
const DROPPED_SCREEN = `────\n❯ ${LONG_PROMPT.slice(2, 92)}\n  ${LONG_PROMPT.slice(92, 182)}\n  ${LONG_PROMPT.slice(182, 272)}\n────\n  ⏵⏵ auto mode on`

test('promptInBox sees an unsent long prompt: wrapped (regression guard), collapsed into a placeholder, or with lost keys', () => {
  assert.equal(promptInBox(WRAPPED_SCREEN, LONG_PROMPT), true)
  assert.equal(promptInBox(DROPPED_SCREEN, LONG_PROMPT), true)
  assert.equal(promptInBox('────\n❯ ote https://a1.io/\n────', LONG_PROMPT), true)
  // The grey hint of an empty box is not the prompt.
  assert.equal(promptInBox('────\n❯ Try "fix lint errors"\n────\n  ⏵⏵ auto mode on', LONG_PROMPT), false)
  assert.equal(promptInBox(PLACEHOLDER_SCREEN, LONG_PROMPT), true)
  assert.equal(promptInBox('────\n❯ [Pasted text #12 +40 lines]\n────', LONG_PROMPT), true)
  // Once sent, the placeholder is only in the history above the empty box.
  assert.equal(promptInBox(PLACEHOLDER_SENT_SCREEN, LONG_PROMPT), false)
  // An empty box is not an unsent prompt.
  assert.equal(promptInBox('────\n❯ \n────', LONG_PROMPT), false)
})

test('submitPrompt presses Enter again while a long prompt sits in the box as a placeholder', async () => {
  let enters = 0
  await submitPrompt(
    { capture: () => (enters >= 3 ? PLACEHOLDER_SENT_SCREEN : PLACEHOLDER_SCREEN), key: () => void enters++ },
    LONG_PROMPT,
    { timeoutMs: 1000, intervalMs: 1, retryMs: 2 },
  )
  assert.equal(enters, 3)
})

test('submitPrompt presses Enter until a wrapped prompt, or one with lost keys, is sent', async () => {
  for (const unsent of [WRAPPED_SCREEN, DROPPED_SCREEN]) {
    let enters = 0
    await submitPrompt(
      { capture: () => (enters >= 3 ? PLACEHOLDER_SENT_SCREEN : unsent), key: () => void enters++ },
      LONG_PROMPT,
      { timeoutMs: 1000, intervalMs: 1, retryMs: 2 },
    )
    assert.equal(enters, 3)
  }
})

// The issue names "Claude finishes", which is waitForTurnEnd: the resend and the fail-fast must work on that path too.
test('waitForTurnEnd fails fast with "prompt not sent" when a long prompt stays in the box', async () => {
  const signal = join(tempDir('wfte-'), 'signal')
  for (const stuck of [PLACEHOLDER_SCREEN, DROPPED_SCREEN]) {
    let enters = 0
    await assert.rejects(
      waitForTurnEnd(signal, 0, 5000, undefined, {
        prompt: LONG_PROMPT,
        io: { capture: () => stuck, key: () => void enters++ },
        retryMs: 2,
        intervalMs: 1,
      }),
      /prompt not sent/,
    )
    assert.equal(enters, 8)
  }
})

// No wall-clock race: the budget leaves two retry windows before the timeout, so the give-up comes first (issue #379).
test('resendBudget keeps the resend budget two retry windows inside the timeout', () => {
  assert.equal(resendBudget(40, 5), 6)
  assert.equal(resendBudget(30, 5), 4)
  assert.equal(resendBudget(5000, 5), 8, 'a long timeout is capped at 8 resends')
  assert.equal(resendBudget(10, 5), 1, 'a short timeout still allows one resend')
  assert.equal(resendBudget(1000, 60000), 1)
  // Resends plus the first Enter fit in the timeout, so the last window ends before it.
  assert.ok((resendBudget(40, 5) + 1) * 5 <= 40)
})

test('submitPrompt fails fast with "prompt not sent" when Enter never sends the prompt', async () => {
  let enters = 0
  await assert.rejects(
    submitPrompt({ capture: () => PLACEHOLDER_SCREEN, key: () => void enters++ }, LONG_PROMPT, {
      timeoutMs: 5000,
      intervalMs: 1,
      retryMs: 2,
    }),
    /prompt not sent/,
  )
  assert.equal(enters, 1 + 8, `Enter keys: ${enters}`)
})

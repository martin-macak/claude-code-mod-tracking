// Wiring tests: rows in, `/track` text, pane and band out. The kit stubs sit beneath the mod.
// The kit does not reset `$.state` on a new session id. A test that needs it passes `isolateState`: the stub then keeps
// the state per id, which is what a real /clear does. The live smoke run covers the rest.

import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import type { ItemRecord, ProcessRecord } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import {
  BAND,
  commandRow,
  current,
  graphqlCalls,
  PANE,
  prompt,
  quiet,
  res,
  response,
  SESSION,
  START,
  sleep,
  toolResult,
  track,
  viewCalls,
  world,
} from './fixtures/world'

// ---------------------------------------------------------------- capture and refresh

test('prompt row: issue #5 and a Jira URL are listed by /track with refreshed status', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('Look at issue #5 and https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('#5')
  expect(text).toContain('Web five')
  expect(text).toContain('ISS-1')
  expect(text).toContain('Draft')
  expect(graphqlCalls(calls).length).toBe(2)
  expect(viewCalls(calls).map(c => c[4])).toEqual(['ISS-1'])
})

test('a later row with a new item refreshes it after the capture debounce', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('first issue #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(2)
  await $.session.append(prompt('and now issue #9'))
  expect(graphqlCalls(calls).length).toBe(3) // short-ref pre-check ran, debounce has not run yet
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(4)
  expect((await track($)).text).toContain('Web nine')
})

test('prompt row: keyworded short refs are kept only when the item exists and is open', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('Check issue #5 and issue #404'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Web five')
  expect(text).not.toContain('#404')
})

test('rows of other makers are not captured: task notification, isMeta, subagent, coordinator', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('done: https://github.com/cli/cli/pull/14640 and #5', 'task-notification'))
  await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-2', 'composer', { isMeta: true }))
  await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-3', 'composer', { agentId: 'agent-7' }))
  await $.session.append(prompt('go and read #6', 'coordinator'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toBe('No tracked items yet.')
  expect(graphqlCalls(calls).length).toBe(0)
})

test('command rows: our own engine output is skipped, a composer command is read from its args', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(commandRow('<command-name>/track</command-name>\n<command-args>#77</command-args>', 'engine'))
  await $.session.append(
    commandRow('<local-command-stdout>Jira  ISS-77  #77 https://leak.example/x</local-command-stdout>', 'engine'),
  )
  await $.session.append(
    commandRow(
      '<command-message>foo</command-message>\n<command-name>/foo https://outside.example/o</command-name>\n<command-args>issue #9</command-args>',
      'composer',
    ),
  )
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('#9')
  expect(text).toContain('Web nine')
  expect(text).not.toContain('ISS-77')
  expect(text).not.toContain('#77')
  expect(text).not.toContain('leak.example')
  expect(text).not.toContain('outside.example')
})

test('tool-result row: only explicit GitHub and Jira URLs count, never bare #N or web links', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(toolResult('see https://example.com and #7, build #8 failed'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toBe('No tracked items yet.')
  await $.session.append(toolResult([{ type: 'text', text: 'opened https://github.com/cli/cli/pull/14640 just now' }]))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('cli/cli#14640')
  expect(text).not.toContain('example.com')
  expect(text).not.toContain('#7')
})

test('tool-result row: Jira URLs on a foreign site are skipped', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(
    toolResult(
      "tests/view.test.ts:117: expect(root!.href).toBe('https://acme.atlassian.net/browse/ISS-101')\nsee https://vertice.atlassian.net/browse/ISS-2",
    ),
  )
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('ISS-101')
  expect(text).not.toContain('ISS-2')
})

test('processes: a background Bash task appears and task-notification updates its state', async ($, on) => {
  const { calls, fake } = world(on)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' }
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', tool_use_id: 'toolu_bg_1' } as never)
  await quiet(calls)
  let text = (await track($)).text ?? ''
  expect(text).toContain('Processes')
  expect(text).toContain('npm run dev')
  expect(text).toContain('running')
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'task-notification' },
    uuid: 'u-task-1',
    task: { id: 'task-bg-1', status: 'completed', toolUseId: 'toolu_bg_1' },
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'done' }] },
  } as never)
  text = (await track($)).text ?? ''
  expect(text).toContain('completed')
  expect(text).toMatch(/Processes\s+1 tracked/)
})

test('processes: a real task-notification row (text only, no task field) completes the background task', async ($, on) => {
  const { calls, fake } = world(on)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bcsvumhut' }
  await $.tool.call({ tool: 'Bash', command: 'sleep 90', tool_use_id: 'toolu_01GfuArVsMsjZQPMycBmm7jG' } as never)
  await quiet(calls)
  expect((await track($)).text ?? '').toMatch(/sleep 90[^\n]*running/)
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'task-notification', producer: 'session-task' },
    uuid: 'u-task-real',
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            '<task-notification>\n<task-id>bcsvumhut</task-id>\n<tool-use-id>toolu_01GfuArVsMsjZQPMycBmm7jG</tool-use-id>\n' +
            '<output-file>/tmp/bcsvumhut.output</output-file>\n<status>completed</status>\n' +
            '<summary>Background command "sleep 90" completed (exit code 0)</summary>\n</task-notification>',
        },
      ],
    },
  } as never)
  expect((await track($)).text ?? '').toMatch(/sleep 90[^\n]*completed/)
})

test('processes: notification text typed by the person does not change a task state', async ($, on) => {
  const { calls, fake } = world(on)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bcsvumhut' }
  await $.tool.call({ tool: 'Bash', command: 'sleep 90', tool_use_id: 'toolu_x' } as never)
  await quiet(calls)
  await $.session.append(
    prompt('<task-notification><task-id>bcsvumhut</task-id><status>killed</status></task-notification>'),
  )
  expect((await track($)).text ?? '').toMatch(/sleep 90[^\n]*running/)
})

test('processes: docker missing shows a reason and does not break /track', async ($, on) => {
  const { fake } = world(on, { missing: ['docker'] })
  fake.tools.Bash = { stdout: 'a1b2c3d4e5f6\n', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'docker run -d --name api nginx:latest' } as never)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Processes')
  expect(text).toContain('docker not installed')
})

test('processes: docker probe errors are surfaced instead of marking containers exited', async ($, on) => {
  const { fake } = world(on)
  fake.tools.Bash = { stdout: 'a1b2c3d4e5f6\n', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'docker run -d --name api nginx:latest' } as never)
  const text = (await track($)).text ?? ''
  expect(text).toContain('unexpected call: docker ps')
})

// ---------------------------------------------------------------- processes: PR #34 manual-test findings

const CID = 'c'.repeat(12) + '0123456789abcdef'.repeat(3) + 'abcd'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** `ps -o lstart` text for a moment, in local time. */
function lstart(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}
const argvIs = (argv: string[], ...head: string[]) => head.every((x, i) => argv[i] === x)

test('processes: docker run -d after docker info in one Bash call shows the container as up', async ($, on) => {
  const { fake } = world(on)
  fake.run = argv =>
    argvIs(argv, 'docker', 'ps', '-a', '--no-trunc') ? res(`${CID}\ttrack-test-sleep\tUp 3 seconds\n`) : undefined
  fake.tools.Bash = {
    stdout: '29.0.1\nContainerd fff62f14765df376e5fc36f5a8f8e795b5670f61\n' + CID + '\n',
    stderr: '',
    interrupted: false,
  }
  await $.tool.call({
    tool: 'Bash',
    command: "docker info --format '{{.ServerVersion}}'; docker run -d --name track-test-sleep alpine sleep 1800",
  } as never)
  const text = (await track($)).text ?? ''
  expect(text).toContain('track-test-sleep')
  expect(text).toContain('up')
  expect(text).not.toContain('exited')
})

test('processes: docker compose up -d at the end of a compound command shows the project', async ($, on) => {
  const { fake } = world(on)
  fake.run = argv =>
    argvIs(argv, 'docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=track-compose')
      ? res('Up 2 seconds\n')
      : argvIs(argv, 'docker', 'ps')
        ? res('')
        : undefined
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({
    tool: 'Bash',
    command:
      "mkdir -p /tmp/tc && printf 'services:\\n  web:\\n    image: nginx\\n' > /tmp/tc/docker-compose.yml && docker compose -p track-compose -f /tmp/tc/docker-compose.yml up -d",
  } as never)
  const text = (await track($)).text ?? ''
  expect(text).toContain('track-compose')
  expect(text).toContain('up')
  expect(text).not.toContain('exited')
})

test('processes: compose without -p takes its project name from the session cwd', async ($, on) => {
  const { fake } = world(on)
  fake.cwd = '/work/My-App'
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'docker compose up -d' } as never)
  expect((await track($)).text ?? '').toContain('my-app')
})

test('processes: a live screen session stays running although screen -ls exits 1', async ($, on) => {
  const { fake } = world(on)
  fake.run = argv =>
    argvIs(argv, 'screen', '-ls')
      ? res('There is a screen on:\n\t7611.watch\t(Detached)\n1 Socket in /tmp/.screen.\n', 1)
      : undefined
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd app && screen -dmS watch npm run watch' } as never)
  const text = (await track($)).text ?? ''
  expect(text).toContain('watch')
  expect(text).toContain('running')
  expect(text).not.toContain('exited')
})

test('processes: a Docker daemon error keeps docker rows and still probes tmux', async ($, on) => {
  const { fake } = world(on)
  fake.run = argv =>
    argvIs(argv, 'docker', 'ps')
      ? res('', 1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
      : argvIs(argv, 'tmux', 'ls')
        ? res('', 1, 'no server running on /private/tmp/tmux-501/default')
        : undefined
  fake.tools.Bash = { stdout: CID + '\n', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'docker run -d --name api nginx; tmux new -d -s dev' } as never)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Cannot connect to the Docker daemon')
  expect(text).toMatch(/api[^\n]*running/)
  expect(text).toMatch(/dev[^\n]*exited/)
})

test('processes: a Docker daemon that stays down does not open the breaker for the tmux probe', async ($, on) => {
  const { fake } = world(on)
  let tmuxUp = true
  fake.run = argv =>
    argvIs(argv, 'docker', 'ps')
      ? res('', 1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
      : argvIs(argv, 'tmux', 'ls')
        ? tmuxUp
          ? res('dev: 1 windows (created Tue)\n')
          : res('', 1, 'no server running on /private/tmp/tmux-501/default')
        : undefined
  fake.tools.Bash = { stdout: CID + '\n', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'docker run -d --name api nginx; tmux new -d -s dev' } as never)
  for (let n = 0; n < 4; n++) await track($)
  tmuxUp = false
  expect((await track($)).text ?? '').toMatch(/dev[^\n]*exited/)
})

test('processes: a detached process without echo $! is found by the probe and then followed by pid', async ($, on) => {
  const { fake, calls } = world(on)
  let alive = true
  fake.run = argv => {
    if (argvIs(argv, 'ps', '-A')) return res(`  4321 ${lstart(Date.now() - 1000)} sleep 100\n`)
    if (argvIs(argv, 'ps', '-p', '4321')) return alive ? res(`${lstart(Date.now() - 1000)} sleep 100\n`) : res('', 1)
    return undefined
  }
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'nohup sleep 100 > /dev/null 2>&1 &', tool_use_id: 'toolu_d' } as never)
  let text = (await track($)).text ?? ''
  expect(text).toMatch(/sleep 100[^\n]*running/)
  alive = false
  text = (await track($)).text ?? ''
  expect(calls.some(c => argvIs(c, 'ps', '-p', '4321'))).toBe(true)
  expect(text).toMatch(/sleep 100[^\n]*exited/)
})

test('processes: a detached process without a pid that ps cannot find is exited', async ($, on) => {
  const { fake } = world(on)
  fake.run = argv => (argvIs(argv, 'ps', '-A') ? res('    1 Tue Oct 13 08:00:00 2026 /sbin/launchd\n') : undefined)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'nohup sleep 100 > /dev/null 2>&1 &' } as never)
  expect((await track($)).text ?? '').toMatch(/sleep 100[^\n]*exited/)
})

test('response row: a web link and a PR URL are captured; the row is stored as made', async ($, on) => {
  const { clock, calls } = world(on)
  const row = response(
    'See [the docs](https://code.claude.com/docs/en/plugins) and https://github.com/cli/cli/pull/14640.',
  )
  const stored = await $.session.append(row)
  expect(stored.message?.content).toEqual(row.message.content)
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('the docs')
  expect(text).toContain('cli/cli#14640')
})

test('response row: a non-existent GitHub URL is discarded before it can be listed or stored', async ($, on) => {
  const { clock, calls, store } = world(on, { isolateState: true })
  await $.session.append(response('See https://github.com/no-such-owner-xyz/no-such-repo/pull/9'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toBe('No tracked items yet.')
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  expect(store.has('s:' + SESSION)).toBe(false)
})

test('a URL and a bare #N for the same item make one item', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('check issue #5'))
  await $.session.append(response('Fixed https://github.com/acme/web/issues/5 already.'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text.match(/Web five/g)?.length).toBe(1)
})

test('pane: the dismiss button removes a manually tracked row', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('check issue #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await track($)
  const ui = (await mountPane($)) as PaneUi & { press(q: unknown): Promise<void> }
  await ui.press({ key: 'dismiss-gh:github.com/acme/web#5' })
  await quiet(calls)
  expect((await track($)).text).toBe('No tracked items yet.')
  await ui.unmount()
})

test('/clear carry-over, store path: the items of the session just left come back', async ($, on) => {
  const old: ItemRecord[] = [
    {
      key: 'web:https://old.example/x',
      category: 'web',
      url: 'https://old.example/x',
      label: 'Old page',
      sources: ['response'],
      firstSeen: 1,
      lastSeen: 1,
      seenCount: 1,
    },
    {
      key: 'gh:github.com/acme/web#3',
      category: 'github',
      url: 'https://github.com/acme/web/issues/3',
      label: 'acme/web#3',
      sources: ['prompt'],
      firstSeen: 2,
      lastSeen: 2,
      seenCount: 1,
      host: 'github.com',
      owner: 'acme',
      repo: 'web',
      number: 3,
      type: 'issue',
      title: 'Old three',
      state: 'closed',
      refreshedAt: Date.now(),
    },
  ]
  const { clock, calls } = world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { items: old } } })
  await $.session.append(prompt('first https://example.org/a')) // learns the id; no session.start, so nothing is restored
  current.id = 'sess-2' // what /clear does
  await $.session.append(prompt('then issue #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Old page')
  expect(text).toContain('Old three')
  expect(text).toContain('Web five')
  expect(text).toContain('example.org/a')
})

test('/clear carry-over also happens on /track alone', async ($, on) => {
  const old: ItemRecord[] = [
    {
      key: 'web:https://old.example/x',
      category: 'web',
      url: 'https://old.example/x',
      label: 'Old page',
      sources: ['response'],
      firstSeen: 1,
      lastSeen: 1,
      seenCount: 1,
    },
  ]
  world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { items: old } } })
  await $.session.append(prompt('first https://example.org/a'))
  current.id = 'sess-2'
  expect((await track($)).text).toContain('Old page')
})

test('/clear carry-over also keeps tracked processes from the session just left', async ($, on) => {
  const oldProc: ProcessRecord[] = [
    {
      id: 'task:task-bg-1',
      kind: 'background-task',
      name: 'npm run dev',
      state: 'running',
      firstSeen: 1,
      lastSeen: 1,
      taskId: 'task-bg-1',
    },
  ]
  world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { processes: oldProc } } })
  await $.session.append(prompt('first https://example.org/a'))
  current.id = 'sess-2'
  const text = (await track($)).text ?? ''
  expect(text).toContain('Processes')
  expect(text).toContain('npm run dev')
  expect(text).toContain('running')
})

test('/track refresh clears a logged-out gh and asks again', async ($, on) => {
  const { clock, calls } = world(on, { ghAuthFails: 1 })
  await $.session.append(response('PR: https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(1)
  const before = (await track($)).text ?? ''
  expect(before).toContain('not logged in')
  expect(graphqlCalls(calls).length).toBe(1) // opening the pane makes no more gh calls
  const after = (await track($, 'refresh')).text ?? ''
  expect(graphqlCalls(calls).length).toBe(2)
  expect(after).not.toContain('not logged in')
  expect(after).toContain('✗ checks')
})

test('a tool that is not installed is named in its section; the other tool still works', async ($, on) => {
  const { clock, calls } = world(on, { missing: ['acli'] })
  await $.session.append(prompt('see issue #5 and https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('not installed')
  expect(text).toContain('Web five')
  expect(text).toContain('ISS-1')
})

test('tool-result row of 1 MB settles fast, is stored whole, and a URL near its start is captured', async ($, on) => {
  const { clock, calls } = world(on)
  const big = 'https://github.com/cli/cli/pull/14640 ' + 'x'.repeat(1_000_000)
  const t0 = Date.now()
  const stored = await $.session.append(toolResult(big))
  expect(Date.now() - t0).toBeLessThan(3000)
  const block = (stored.message!.content as unknown as { content: string }[])[0]!
  expect(block.content.length).toBe(big.length)
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toContain('cli/cli#14640')
})

// ---------------------------------------------------------------- session start, store, commands

test('session.start registers /track with its hint', async ($, on) => {
  const { registered } = world(on)
  await $.session.start(START)
  expect(registered).toEqual([{ name: 'track', argumentHint: '[refresh|clear]' }])
})

test('session.start backfills from the transcript with the same rules per role', async ($, on) => {
  world(on, {
    messages: [
      { role: 'user', text: 'please look at issue #5', toolUses: [] },
      { role: 'user', text: '<local-command-stdout>ISS-88 #88</local-command-stdout>', toolUses: [] },
      {
        role: 'user',
        text: '<command-message>foo</command-message>\n<command-name>/foo https://outside.example/o</command-name>\n<command-args>issue #9 and issue #10</command-args>',
        toolUses: [],
      },
      { role: 'assistant', text: 'It is in [docs](https://docs.example/a) and issue #6', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 't',
            tool: 'Bash',
            input: {},
            text: 'https://github.com/cli/cli/pull/14640 and #11 and https://tool.example/w',
          },
        ],
      },
    ],
  })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toContain('#5')
  expect(text).toContain('docs.example/a')
  expect(text).not.toContain('#6')
  expect(text).toContain('cli/cli#14640')
  expect(text).toContain('#9')
  expect(text).not.toContain('#10')
  expect(text).not.toContain('#11')
  expect(text).not.toContain('outside.example')
  expect(text).not.toContain('tool.example')
  expect(text).not.toContain('ISS-88')
})

test('session.start restores the stored copy of a session it knows', async ($, on) => {
  const stored: ItemRecord = {
    key: 'web:https://kept.example/',
    category: 'web',
    url: 'https://kept.example/',
    label: 'Kept page',
    sources: ['response'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { items: [stored] } } })
  await $.session.start(START)
  expect((await track($)).text).toContain('Kept page')
})

test('session.start prunes stored tool-only Jira items from a foreign site', async ($, on) => {
  const kept: ItemRecord = {
    key: 'jira:acme.atlassian.net/ISS-1',
    category: 'jira',
    url: 'https://acme.atlassian.net/browse/ISS-1',
    label: 'ISS-1',
    sources: ['prompt'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
    site: 'acme.atlassian.net',
    issueKey: 'ISS-1',
    trackOnly: false,
    children: [],
  }
  const pruned: ItemRecord = {
    key: 'jira:vertice.atlassian.net/ISS-2',
    category: 'jira',
    url: 'https://vertice.atlassian.net/browse/ISS-2',
    label: 'ISS-2',
    sources: ['tool'],
    firstSeen: 2,
    lastSeen: 2,
    seenCount: 1,
    site: 'vertice.atlassian.net',
    issueKey: 'ISS-2',
    trackOnly: false,
    children: [],
  }
  world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { items: [kept, pruned] } } })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toContain('ISS-1')
  expect(text).not.toContain('ISS-2')
})

test('a burst of rows makes one store write after the delay; an empty list never replaces a stored one', async ($, on) => {
  const { clock, store, calls } = world(on)
  await $.session.append(response('https://one.example/ and https://two.example/'))
  await $.session.append(response('https://three.example/'))
  expect(store.size).toBe(0)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  expect((store.get('s:' + SESSION) as { items: unknown[] }).items.length).toBe(3)
  expect(store.get('index')).toEqual([SESSION])
  await track($, 'clear')
  expect(store.has('s:' + SESSION)).toBe(false)
  await clock.advance(LIMITS.flushMs + 10)
  expect(store.has('s:' + SESSION)).toBe(false)
})

test('a flush that finds an empty list writes nothing', async ($, on) => {
  const { clock, store, calls } = world(on)
  await $.session.append(response('https://one.example/')) // schedules a flush
  await track($, 'clear') // empties the list before the flush runs
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect(store.has('s:' + SESSION)).toBe(false)
})

test('the store keeps the newest sessions only', async ($, on) => {
  const seed: Record<string, unknown> = { index: Array.from({ length: LIMITS.keepSessions + 5 }, (_, k) => 'old' + k) }
  for (const id of seed.index as string[]) seed['s:' + id] = { items: [] }
  const { clock, store } = world(on, { seed })
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  const index = store.get('index') as string[]
  expect(index.length).toBe(LIMITS.keepSessions)
  expect(index[0]).toBe(SESSION)
  expect(store.has('s:old' + (LIMITS.keepSessions + 4))).toBe(false)
})

test('/track right after the first row waits for the probes, so the sections never say "checking"', async ($, on) => {
  world(on, { acliProbeMs: 80 })
  await $.session.append(response('https://github.com/cli/cli/pull/14640 and https://acme.atlassian.net/browse/ISS-1'))
  const text = (await track($)).text ?? ''
  expect(text).not.toContain('checking')
  expect(text).toContain('ready')
})

test('/track clear empties the list; an unknown argument prints the usage', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(response('https://one.example/'))
  expect((await track($)).text).toContain('one.example')
  expect((await track($, 'clear')).text).toBe('Tracking list cleared.')
  expect((await track($)).text).toBe('No tracked items yet.')
  expect((await track($, 'bogus')).text).toContain('Usage: /track')
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
})

test('the tick refreshes with the pane closed: it starts at session.start (A1)', async ($, on) => {
  const { clock, calls } = world(on, { ghSilent: true })
  await $.session.start(START)
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const before = graphqlCalls(calls).length
  await clock.advance(LIMITS.tickMs + 10) // no pane was ever opened
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(before + 1)
})

test('a tick with unchanged items makes no store write', async ($, on) => {
  const { clock, calls, fake } = world(on)
  await $.session.start(START)
  await $.session.append(response('https://x.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  const writes = fake.storeSets
  expect(writes).toBeGreaterThan(0)
  await clock.advance(LIMITS.tickMs * 3)
  await quiet(calls)
  expect(fake.storeSets).toBe(writes)
})

// ---------------------------------------------------------------- review fixes

const webRec = (url: string, label: string): ItemRecord => ({
  key: 'web:' + url,
  category: 'web',
  url,
  label,
  sources: ['response'],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
})
const KEPT = webRec('https://kept.example/', 'Kept page')

type PaneUi = {
  find(q: unknown): Promise<unknown>
  unmount(): Promise<void>
}
const mountPane = ($: Engine) => $.ui.mount({ ...PANE, surface: 'terminal' } as never) as unknown as Promise<PaneUi>

test('/clear while a flush is still pending: the items are saved under the old id and carried over', async ($, on) => {
  const { clock, store, calls } = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/')) // the flush is due in flushMs
  current.id = 'sess-2' // /clear: a new id and an empty state, before the flush ran
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect((store.get('s:' + SESSION) as { items: unknown[] } | undefined)?.items.length).toBe(1)
  expect((store.get('s:sess-2') as { items: unknown[] } | undefined)?.items.length).toBe(1) // the same flush copies the carried list
  expect((await track($)).text).toContain('one.example')
})

test('the tick notices /clear and brings the items back while the pane is open', async ($, on) => {
  const { clock, calls } = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await track($) // opens the pane and starts the tick
  current.id = 'sess-2' // /clear: the command row has no args, so no capture runs
  await clock.advance(LIMITS.tickMs + 10)
  await quiet(calls)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'one.example' })).toBeDefined()
  await ui.unmount()
})

test('/resume of a known session restores that session, not the one just left', async ($, on) => {
  const { store } = world(on, {
    isolateState: true,
    seed: { index: ['sess-b'], 's:sess-b': { items: [webRec('https://beta.example/', 'beta.example')] } },
    messages: [{ role: 'assistant', text: 'see https://transcript.example/t', toolUses: [] }],
  })
  await $.session.append(response('https://alpha.example/'))
  current.id = 'sess-b' // /resume
  const text = (await track($)).text ?? ''
  expect(text).toContain('beta.example')
  expect(text).toContain('transcript.example') // the backfill runs, as at startup
  expect(text).not.toContain('alpha.example')
  expect((store.get('s:' + SESSION) as { items: unknown[] }).items.length).toBe(1) // the left session is kept as it was
})

test('after /clear the tool statuses are published again', async ($, on) => {
  const { clock, calls, states } = world(on, { isolateState: true })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  current.id = 'sess-2'
  await $.session.append(prompt('hello'))
  const tools = states.get('sess-2|artifact-tracking|tools|')?.value as
    | { gh: { available: boolean | null } }
    | undefined
  expect(tools?.gh.available).toBe(true)
})

test('an ssh host alias is not kept as the session repo: gh resolves it and #N merges with the URL form', async ($, on) => {
  const { clock, store, calls } = world(on, {
    remote: 'git@github-work:acme/web.git',
    badHosts: ['github-work'],
    repoView: '{"nameWithOwner":"acme/web","url":"https://github.com/acme/web"}',
  })
  await $.session.append(prompt('check issue #5'))
  await $.session.append(response('Fixed https://github.com/acme/web/issues/5 already.'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  expect((store.get('s:' + SESSION) as { items: unknown[] }).items.length).toBe(1)
  expect((await track($)).text).toContain('Web five')
})

test('session.start does not wait for the check of a non-github host', async ($, on) => {
  world(on, {
    remote: 'git@ghe.corp:acme/web.git',
    authMs: 400,
    seed: { index: [SESSION], ['s:' + SESSION]: { items: [KEPT] } },
  })
  const t0 = Date.now()
  await $.session.start(START)
  expect(Date.now() - t0).toBeLessThan(250)
  expect((await track($)).text).toContain('Kept page')
})

test('session.start: keyworded #N from the transcript is resolved once the repo is known', async ($, on) => {
  const { clock, calls } = world(on, { messages: [{ role: 'user', text: 'please look at issue #5', toolUses: [] }] })
  await $.session.start(START)
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toContain('Web five')
})

test('session.start restores even when command.register is refused', async ($, on) => {
  world(on, { denyRegister: true, seed: { index: [SESSION], ['s:' + SESSION]: { items: [KEPT] } } })
  await $.session.start(START)
  expect((await track($)).text).toContain('Kept page')
})

test('session.start restores a stored copy although the index lost its id', async ($, on) => {
  world(on, { seed: { index: ['other'], ['s:' + SESSION]: { items: [KEPT] } } })
  await $.session.start(START)
  expect((await track($)).text).toContain('Kept page')
})

test('every session.start arms the tick, with or without a pane, and one tick makes one refresh', async ($, on) => {
  const { clock, calls } = world(on, { ghSilent: true })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const before = graphqlCalls(calls).length
  await $.session.start(START)
  await clock.advance(LIMITS.tickMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(before + 1)
})

test('one refused state write does not stop capture for the rest of the session', async ($, on) => {
  const { clock, calls } = world(on, { isolateState: true, denyItemWrites: 1 })
  await $.session.append(prompt('check issue #5'))
  await $.session.append(prompt('and issue #9'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Web nine')
  expect(text).not.toContain('could not run')
})

test('a refused flush timer does not stop the store mirror for good', async ($, on) => {
  const { clock, store, calls } = world(on, { refuseAfter: LIMITS.flushMs })
  await $.session.append(response('https://one.example/')) // the engine refuses its flush timer
  await clock.advance(LIMITS.flushMs * 3 + 10) // long overdue now
  await quiet(calls)
  await $.session.append(response('https://two.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect((store.get('s:' + SESSION) as { items: unknown[] } | undefined)?.items.length).toBe(2)
})

test('/track refresh during a run in flight waits for it and prints the refreshed list', async ($, on) => {
  const { clock, calls } = world(on, { ghDelayMs: 150 })
  await $.session.append(prompt('check https://github.com/acme/web/issues/5'))
  await clock.advance(LIMITS.captureDebounceMs + 10) // the capture run starts; its gh call takes 150 ms
  expect(graphqlCalls(calls).length).toBe(1) // the capture run is in flight
  const text = (await track($, 'refresh')).text ?? ''
  expect(graphqlCalls(calls).length).toBe(2) // the forced run ran before the command printed
  expect(text).toContain('Web five')
  await quiet(calls)
})

test('the transcript backfill skips system reminders and other meta wrappers', async ($, on) => {
  world(on, {
    messages: [
      { role: 'user', text: '<system-reminder>see https://meta.example/m and #12</system-reminder>', toolUses: [] },
      { role: 'user', text: 'plain https://plain.example/p', toolUses: [] },
    ],
  })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toContain('plain.example')
  expect(text).not.toContain('meta.example')
  expect(text).not.toContain('#12')
})

// ---------------------------------------------------------------- pane and band

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane: rows are drawn, the Jira fold button hides the children (${surface})`, async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.append(prompt('Look at issue #5 and https://acme.atlassian.net/browse/ISS-1'))
    await clock.advance(LIMITS.captureDebounceMs + 10)
    await quiet(calls)
    await track($)
    await quiet(calls)
    const ui = (await $.ui.mount({ ...PANE, surface } as never)) as Awaited<ReturnType<Engine['ui']['mount']>> & {
      find(q: unknown): Promise<unknown>
      press(q: unknown): Promise<void>
      unmount(): Promise<void>
    }
    expect(await ui.find({ text: 'ISS-1' })).toBeDefined()
    expect(await ui.find({ text: 'Web five' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(await ui.find({ text: 'PROJ-201' })).toBeDefined()
    await ui.press({ key: 'fold-jira:acme.atlassian.net/ISS-1' })
    expect(await ui.find({ text: 'PROJ-201' })).toBeUndefined()
    expect(await ui.find({ text: 'ISS-1' })).toBeDefined()
    await ui.press({ key: 'fold-jira:acme.atlassian.net/ISS-1' })
    expect(await ui.find({ text: 'PROJ-201' })).toBeDefined()
    await ui.unmount()
  })
}

test('pane: the Refresh button asks the coordinator for a manual refresh', async ($, on) => {
  const { clock, calls } = world(on, { ghAuthFails: 1 })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await track($)
  expect(graphqlCalls(calls).length).toBe(1)
  const ui = (await $.ui.mount({ ...PANE, surface: 'terminal' } as never)) as unknown as {
    press(q: unknown): Promise<void>
    unmount(): Promise<void>
  }
  await ui.press({ key: 'refresh' })
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(2)
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band: shows the counts and keeps what the engine draws (${surface})`, async ($, on) => {
    const { clock, calls } = world(on)
    // Stands for the engine's own band, which the hook returns inside its Box as next(e).
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
    await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-1'))
    await clock.advance(LIMITS.captureDebounceMs + 10)
    await quiet(calls)
    const ui = (await $.ui.mount({ ...BAND, surface } as never)) as unknown as {
      find(q: unknown): Promise<unknown>
      unmount(): Promise<void>
    }
    expect(await ui.find({ text: 'Jira 1' })).toBeDefined()
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  })
}

test('band: with nothing tracked the hook yields to the engine', async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  const ui = (await $.ui.mount({ ...BAND, surface: 'terminal' } as never)) as unknown as {
    find(q: unknown): Promise<unknown>
    unmount(): Promise<void>
  }
  expect(await ui.find({ text: 'tracking' })).toBeUndefined()
  expect(await ui.find({ text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('band: while a survey holds the band the hook yields to the engine', async ($, on) => {
  const { clock, calls } = world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const ui = (await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
    surface: 'terminal',
  } as never)) as unknown as {
    find(q: unknown): Promise<unknown>
    unmount(): Promise<void>
  }
  expect(await ui.find({ text: 'Jira 1' })).toBeUndefined()
  expect(await ui.find({ text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

// ---------------------------------------------------------------- follow-ups to #1

test('pane: a failing state read draws a short notice, never throws to the engine', async ($, on) => {
  const { clock, calls } = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  current.failItemsRead = true
  const ui = await mountPane($)
  expect(await ui.find({ text: 'Tracking is unavailable' })).toBeDefined()
  await ui.unmount()
})

test('band: a failing state read yields to the engine band', async ($, on) => {
  const { clock, calls } = world(on, { isolateState: true })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  current.failItemsRead = true
  const ui = (await $.ui.mount({ ...BAND, surface: 'terminal' } as never)) as unknown as {
    find(q: unknown): Promise<unknown>
    unmount(): Promise<void>
  }
  expect(await ui.find({ text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('after /clear the tick brings items back with short #N keys for the session repo', async ($, on) => {
  const { clock, calls } = world(on, { isolateState: true })
  await $.session.append(prompt('check issue #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await track($) // opens the pane and starts the tick
  current.id = 'sess-2' // /clear: new id, empty state, session repo forgotten
  await clock.advance(LIMITS.tickMs + 10)
  await quiet(calls)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'Web five' })).toBeDefined()
  expect(await ui.find({ text: 'acme/web#5' })).toBeUndefined()
  await ui.unmount()
})

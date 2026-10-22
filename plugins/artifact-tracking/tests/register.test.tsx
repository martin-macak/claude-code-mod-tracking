// Wiring tests: rows in, `/track` text, pane and band out. The kit stubs sit beneath the mod.
// The kit does not reset `$.state` on a new session id. A test that needs it passes `isolateState`: the stub then keeps
// the state per id, which is what a real /clear does. The live smoke run covers the rest.

import type { Engine } from 'claude-code/testing'
import { expect, mock } from 'claude-code/testing'
import type { ItemRecord, ProcessRecord } from './fixtures/contracts'
import * as ev from './fixtures/events'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { BG_START_MAIN, BG_START_SYNC_AGENT, MID_TURN_NOTICE } from './fixtures/notices'
import { mountPane, select } from './fixtures/pane'
import { reasonsOfSources } from './fixtures/reasons'
import { expectLinear } from './fixtures/scaling'
import {
  BAND,
  clearSession,
  commandRow,
  current,
  editDone,
  fileTool,
  graphqlCalls,
  PANE,
  prompt,
  quiet,
  readDone,
  res,
  response,
  SESSION,
  START,
  sleep,
  toolResult,
  track,
  until,
  viewCalls,
  world,
  writeCreated,
  writeUpdated,
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

// ---------------------------------------------------------------- Markdown files (issue #28)

const files = async ($: Engine) => (await track($)).text ?? ''

test('files: a Write create shows the path relative to the root and created; the reply passes through', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  const reply = await fileTool($, fake, 'Write', writeCreated('/work/docs/plan.md'))
  expect(reply).toEqual({ result: writeCreated('/work/docs/plan.md') })
  expect(await files($)).toBe('Files  1 files\n  plan.md  docs  created')
})

test('files: a Write update and an Edit count as edits; a later Write create sets created', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  await fileTool($, fake, 'Write', writeUpdated('/work/a.md'))
  expect(await files($)).toBe('Files  1 files\n  a.md  edited 1')
  await fileTool($, fake, 'Edit', editDone('/work/a.md'))
  await fileTool($, fake, 'Write', writeCreated('/work/a.md'))
  expect(await files($)).toBe('Files  1 files\n  a.md  created  edited 2')
})

test('files: only .md paths count, in any case', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  for (const p of ['/work/src/a.ts', '/work/docs/plan.md.bak', '/work/README'])
    await fileTool($, fake, 'Write', writeCreated(p))
  expect(await files($)).toBe('No tracked items yet.')
  await fileTool($, fake, 'Edit', editDone('/work/docs/LOUD.MD'))
  expect(await files($)).toBe('Files  1 files\n  LOUD.MD  docs  edited 1')
})

test('files: a failed, denied, staged or thrown call adds nothing', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  fake.toolReplies.Write = {
    isError: true,
    result: "Error: Claude requested permissions to write to /work/docs/denied.md, but you haven't granted it yet.",
  }
  await $.tool.call({ tool: 'Write', file_path: '/work/docs/denied.md' } as never)
  fake.toolReplies.Write = { isError: true, result: writeCreated('/work/docs/denied.md') }
  await $.tool.call({ tool: 'Write', file_path: '/work/docs/denied.md' } as never)
  fake.toolReplies.Edit = { isError: true, result: 'Error: String to replace not found in file.' }
  await $.tool.call({ tool: 'Edit', file_path: '/work/docs/denied.md' } as never)
  fake.toolReplies.Write = { deny: 'blocked by a hook' }
  await $.tool.call({ tool: 'Write', file_path: '/work/docs/denied.md' } as never).catch(() => {})
  await fileTool($, fake, 'Write', { ...writeCreated('/work/docs/staged.md'), staged: true } as never)
  await fileTool($, fake, 'Edit', { ...editDone('/work/docs/staged.md'), staged: true } as never)
  fake.toolThrows.Write = 'ENOTDIR: not a directory'
  let thrown = false
  await $.tool.call({ tool: 'Write', file_path: '/dev/null/x.md' } as never).catch(() => {
    thrown = true
  })
  expect(thrown).toBe(true)
  expect(await files($)).toBe('No tracked items yet.')
})

test('files: a refused state write does not change the tool reply', async ($, on) => {
  const { fake } = world(on, { isolateState: true, denyItemWrites: 5 })
  await $.session.start(START)
  const reply = await fileTool($, fake, 'Write', writeCreated('/work/docs/plan.md'))
  expect(reply).toEqual({ result: writeCreated('/work/docs/plan.md') })
})

test('files: a relative path joins the session cwd; .. and // spellings are one row', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  await fileTool($, fake, 'Write', writeCreated('notes.md'))
  await fileTool($, fake, 'Write', writeUpdated('/work/docs/../notes.md'))
  await fileTool($, fake, 'Edit', editDone('/work//./notes.md'))
  expect(await files($)).toBe('Files  1 files\n  notes.md  created  edited 2')
})

test('files: two spellings that land on one real path are one row, labelled as first spelled', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  fake.files['/tmp/w/a.md'] = '/private/tmp/w/a.md'
  fake.files['/private/tmp/w/a.md'] = '/private/tmp/w/a.md'
  await fileTool($, fake, 'Write', writeCreated('/tmp/w/a.md'))
  await fileTool($, fake, 'Edit', editDone('/private/tmp/w/a.md'))
  expect(await files($)).toBe('Files  1 files\n  a.md  /tmp/w  created  edited 1')
})

test('files: .git, node_modules, auto-memory and the scratchpad are ignored; plans and CLAUDE.md stay', async ($, on) => {
  const { fake } = world(on)
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const pad = '/private/tmp/claude-501/-work/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/scratchpad'
  for (const p of [
    '/work/.git/notes.md',
    '/work/NODE_MODULES/x/README.md',
    '/home/u/.claude/projects/-work/memory/MEMORY.md',
    `${pad}/notes.md`,
  ])
    await fileTool($, fake, 'Write', writeCreated(p))
  expect(await files($)).toBe('No tracked items yet.')
  for (const p of ['/home/u/.claude/plans/p.md', '/work/CLAUDE.md', '/work/docs/scratchpad/x.md'])
    await fileTool($, fake, 'Write', writeCreated(p))
  expect(await files($)).toBe(
    'Files  3 files\n  p.md  /home/u/.claude/plans  created\n  CLAUDE.md  created\n  x.md  docs/scratchpad  created',
  )
})

test('files: CLAUDE_CONFIG_DIR moves the memory rule', async ($, on) => {
  const { fake } = world(on)
  mock.env(on, { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' })
  await $.session.start(START)
  await fileTool($, fake, 'Write', writeCreated('/cfg/projects/x/memory/a.md'))
  expect(await files($)).toBe('No tracked items yet.')
  await fileTool($, fake, 'Write', writeCreated('/home/u/.claude/projects/x/memory/b.md'))
  expect(await files($)).toContain('b.md  /home/u/.claude/projects/x/memory  created')
})

test('files: the autoMemoryDirectory setting moves the memory rule; ~ joins HOME', async ($, on) => {
  const { fake } = world(on)
  mock.env(on, { HOME: '/home/u' })
  on('settings.read', () => ({ value: { autoMemoryDirectory: '~/notes-mem' } as never }))
  await $.session.start(START)
  await fileTool($, fake, 'Write', writeCreated('/home/u/notes-mem/-work/MEMORY.md'))
  expect(await files($)).toBe('No tracked items yet.')
  await fileTool($, fake, 'Write', writeCreated('/home/u/notes/a.md'))
  expect(await files($)).toBe('Files  1 files\n  a.md  /home/u/notes  created')
})

test('files: a project inside a folder named scratchpad or node_modules keeps its files', async ($, on) => {
  const { fake } = world(on)
  await $.session.start({ ...START, cwd: '/home/u/scratchpad/proj' })
  await fileTool($, fake, 'Write', writeCreated('/home/u/scratchpad/proj/docs/plan.md'))
  expect(await files($)).toBe('Files  1 files\n  plan.md  docs  created')
})

test('files: a Read counts a view on a tracked row and never adds a row', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  await fileTool($, fake, 'Read', readDone('/work/README.md'))
  expect(await files($)).toBe('No tracked items yet.')
  await fileTool($, fake, 'Write', writeCreated('/work/docs/plan.md'))
  await fileTool($, fake, 'Read', readDone('/work/docs/plan.md'))
  await fileTool($, fake, 'Read', readDone('docs/plan.md'))
  expect(await files($)).toBe('Files  1 files\n  plan.md  docs  created  viewed 2')
})

test('files: a reply that names an existing .md adds a mentioned row; a missing one adds nothing', async ($, on) => {
  const { fake } = world(on)
  await $.session.start(START)
  fake.files['/work/README.md'] = '/work/README.md'
  await $.session.append(response('See `README.md:12` and docs/missing.md.'))
  expect(await files($)).toBe('Files  1 files\n  README.md  mentioned')
  await $.session.append(response('README.md again'))
  await fileTool($, fake, 'Edit', editDone('/work/README.md'))
  expect(await files($)).toBe('Files  1 files\n  README.md  mentioned  edited 1')
  await fileTool($, fake, 'Write', writeCreated('/work/README.md'))
  expect(await files($)).toBe('Files  1 files\n  README.md  created  edited 1')
})

test("files: the person's prompt and command args count; tool output and ignored paths do not", async ($, on) => {
  const { fake } = world(on)
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  for (const p of ['/work/docs/a.md', '/work/docs/b.md', '/work/docs/c.md', '/home/u/notes.md']) fake.files[p] = p
  fake.files['/work/.git/d.md'] = '/work/.git/d.md'
  await $.session.append(toolResult('docs/b.md'))
  await $.session.append(prompt('Check docs/a.md and .git/d.md and ~/notes.md'))
  await $.session.append(commandRow('<command-args>docs/c.md</command-args>', 'composer'))
  expect(await files($)).toBe(
    'Files  3 files\n  a.md  docs  mentioned\n  notes.md  /home/u  mentioned\n  c.md  docs  mentioned',
  )
})

test('files: a dismissed row stays dismissed after a later write, edit, read or mention', async ($, on) => {
  const { fake, calls } = world(on)
  await $.session.start(START)
  fake.files['/work/docs/plan.md'] = '/work/docs/plan.md'
  await fileTool($, fake, 'Write', writeCreated('/work/docs/plan.md'))
  const ui = await mountPane($)
  await select($, ui, 'plan.md')
  await ui.press({ key: 'dismiss' })
  await quiet(calls)
  expect(await files($)).toBe('No tracked items yet.')
  await fileTool($, fake, 'Write', writeUpdated('/work/docs/plan.md'))
  await fileTool($, fake, 'Edit', editDone('/work/docs/plan.md'))
  await fileTool($, fake, 'Read', readDone('/work/docs/plan.md'))
  await $.session.append(response('see docs/plan.md'))
  expect(await files($)).toBe('No tracked items yet.')
  await ui.unmount()
})

test('files: a file row is saved to the stored copy', async ($, on) => {
  const { fake, clock, calls, store } = world(on)
  await $.session.start(START)
  await fileTool($, fake, 'Write', writeCreated('/work/docs/plan.md'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  const saved = (store.get('v2:s:' + SESSION) as { items: ItemRecord[] }).items
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({
    key: 'file:/work/docs/plan.md',
    category: 'file',
    url: '/work/docs/plan.md',
    label: '/work/docs/plan.md',
    created: true,
    edits: 0,
  })
})

const storedFile: ItemRecord = {
  key: 'file:/work/docs/plan.md',
  category: 'file',
  url: '/work/docs/plan.md',
  label: '/work/docs/plan.md',
  created: true,
  edits: 2,
  views: 1,
  mentions: 0,
  sources: ['tool'],
  reasons: reasonsOfSources(['tool']),
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 4,
}

test('files: session.start restores a file row from the stored copy', async ($, on) => {
  world(on, { seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [storedFile] } } })
  await $.session.start(START)
  expect(await files($)).toBe('Files  1 files\n  plan.md  docs  created  edited 2  viewed 1')
})

test('files: a resume skips a file row dismissed in this run', async ($, on) => {
  const copy = { items: [storedFile] }
  const { calls } = world(on, {
    isolateState: true,
    seed: { 'v2:index': [SESSION, 'sess-2'], ['v2:s:' + SESSION]: copy, 'v2:s:sess-2': copy },
  })
  await $.session.start(START) // pins the root, so the dismiss list is carried over to the next id
  expect(await files($)).toContain('plan.md  docs')
  const ui = await mountPane($)
  await select($, ui, 'plan.md')
  await ui.press({ key: 'dismiss' })
  await quiet(calls)
  await ui.unmount()
  await clearSession($, { calls }, 'sess-2', 'resume') // a /resume of a session whose stored copy holds the row
  expect(await files($)).toBe('No tracked items yet.')
})

test('files: /clear carries a file row over to the new session', async ($, on) => {
  const { fake, calls } = world(on)
  await $.session.start(START)
  await fileTool($, fake, 'Write', writeCreated('/work/docs/plan.md'))
  await clearSession($, { calls }, 'sess-2', 'clear') // what /clear does
  expect(await files($)).toBe('Files  1 files\n  plan.md  docs  created')
})

test('files: a resume rebuilds file rows from Write, Edit and Read results and mentions in the transcript', async ($, on) => {
  const use = (tool: string, result: unknown, isError = false) => ({
    tool_use_id: `t-${tool}`,
    tool,
    input: {},
    result,
    text: '',
    isError,
  })
  const { fake } = world(on, {
    messages: [
      { role: 'user', text: 'Please read README.md', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          use('Read', readDone('/work/docs/old.md')),
          use('Write', writeCreated('/work/docs/plan.md')),
          use('Edit', editDone('/work/docs/plan.md')),
          use('Read', readDone('/work/docs/plan.md')),
          use('Write', 'Error: denied', true),
          use('Write', writeCreated('/work/node_modules/x/a.md')),
        ],
      },
    ],
  })
  fake.files['/work/README.md'] = '/work/README.md'
  await $.session.start(START)
  expect(await files($)).toBe('Files  2 files\n  README.md  mentioned\n  plan.md  docs  created  edited 1  viewed 1')
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

test('processes: a notice folded into a running turn (door delivery) completes the background task', async ($, on) => {
  const { calls, fake } = world(on)
  fake.tools.Bash = { ...BG_START_MAIN.result }
  await $.tool.call({
    tool: 'Bash',
    command: 'sleep 20; echo done',
    tool_use_id: 'toolu_0167pQhp2xvXTrduu7Tmndwj',
  } as never)
  await quiet(calls)
  expect((await track($)).text ?? '').toMatch(/sleep 20; echo done[^\n]*running/)
  // The row as the headless spike saw it: an attachment named `queued_command`, the notice in a system-reminder.
  await $.session.append({
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: 'u-task-folded',
    message: {
      type: 'attachment',
      name: 'queued_command',
      role: 'user',
      content: [{ type: 'text', text: MID_TURN_NOTICE.text }],
    },
  } as never)
  expect((await track($)).text ?? '').toMatch(/sleep 20; echo done[^\n]*completed/)
})

test('processes: a task that ends with the final response of a headless loop is killed at turn.complete', async ($, on) => {
  const { calls, fake } = world(on)
  fake.tools.Bash = { ...BG_START_SYNC_AGENT.result }
  await $.tool.call({ tool: 'Bash', command: 'sleep 15', tool_use_id: 'toolu_h' } as never)
  await quiet(calls)
  expect((await track($)).text ?? '').toMatch(/sleep 15[^\n]*running/)
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, answer: '' } as never)
  expect((await track($)).text ?? '').toMatch(/sleep 15[^\n]*killed/)
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
  expect(store.has('v2:s:' + SESSION)).toBe(false)
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

test('pane: x removes a manually tracked row', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('check issue #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await track($)
  const ui = await mountPane($)
  await select($, ui, '#5')
  await ui.press({ key: 'dismiss' })
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
      reasons: reasonsOfSources(['response']),
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
      reasons: reasonsOfSources(['prompt']),
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
  const { clock, calls } = world(on, { seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: old } } })
  await $.session.append(prompt('first https://example.org/a')) // learns the id; no session.start, so nothing is restored
  await clearSession($, { calls }, 'sess-2', 'clear') // what /clear does
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
      reasons: reasonsOfSources(['response']),
      firstSeen: 1,
      lastSeen: 1,
      seenCount: 1,
    },
  ]
  const { calls } = world(on, { seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: old } } })
  await $.session.append(prompt('first https://example.org/a'))
  await clearSession($, { calls }, 'sess-2', 'clear', { row: false }) // no /clear row: /track is the first hook
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
  const { calls } = world(on, { seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { processes: oldProc } } })
  await $.session.append(prompt('first https://example.org/a'))
  await clearSession($, { calls }, 'sess-2', 'clear')
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

// The row hook scans at most MAX_TEXT characters, so the cost is checked on texts up to the cap (the big one is 4 times the
// small one). The kit has no CPU clock, so the check reads the wall clock (`wallClock`). That is exact for a run that is
// shorter than a slice of the scheduler, and a run here takes about 1 ms. The 1 MB row after that is stored whole, and its
// URL near the start is captured.
test('tool-result row of 1 MB settles linearly, is stored whole, and a URL near its start is captured', async ($, on) => {
  const { clock, calls } = world(on)
  const result = (chars: number) => 'https://github.com/cli/cli/pull/14640 ' + 'x'.repeat(chars)
  await expectLinear({
    wallClock: true,
    make: k => result(49_000 * k),
    run: async text => {
      await $.session.append(toolResult(text))
    },
  })
  // Above the cap the scan is cut at MAX_TEXT, so only the store path of the row grows with it: the cost stays near linear.
  await expectLinear({
    label: 'above the cap',
    wallClock: true,
    make: k => result(250_000 * k), // 250 KB and 1 MB
    run: async text => {
      await $.session.append(toolResult(text))
    },
  })
  const big = result(1_000_000)
  const stored = await $.session.append(toolResult(big))
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
  expect(registered).toEqual([
    {
      name: 'track',
      argumentHint:
        '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>|qa [n]]',
    },
  ])
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
    reasons: reasonsOfSources(['response']),
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  world(on, { seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [stored] } } })
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
    reasons: reasonsOfSources(['prompt']),
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
    reasons: reasonsOfSources(['tool']),
    firstSeen: 2,
    lastSeen: 2,
    seenCount: 1,
    site: 'vertice.atlassian.net',
    issueKey: 'ISS-2',
    trackOnly: false,
    children: [],
  }
  world(on, { seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [kept, pruned] } } })
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
  expect((store.get('v2:s:' + SESSION) as { items: unknown[] }).items.length).toBe(3)
  expect(store.get('v2:index')).toEqual([SESSION])
  await track($, 'clear')
  expect(store.has('v2:s:' + SESSION)).toBe(false)
  await clock.advance(LIMITS.flushMs + 10)
  expect(store.has('v2:s:' + SESSION)).toBe(false)
})

test('a flush that finds an empty list writes nothing', async ($, on) => {
  const { clock, store, calls } = world(on)
  await $.session.append(response('https://one.example/')) // schedules a flush
  await track($, 'clear') // empties the list before the flush runs
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect(store.has('v2:s:' + SESSION)).toBe(false)
})

test('the store keeps the newest sessions only', async ($, on) => {
  const seed: Record<string, unknown> = {
    'v2:index': Array.from({ length: LIMITS.keepSessions + 5 }, (_, k) => 'old' + k),
  }
  for (const id of seed['v2:index'] as string[]) seed['v2:s:' + id] = { items: [] }
  const { clock, store } = world(on, { seed })
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  const index = store.get('v2:index') as string[]
  expect(index.length).toBe(LIMITS.keepSessions)
  expect(index[0]).toBe(SESSION)
  expect(store.has('v2:s:old' + (LIMITS.keepSessions + 4))).toBe(false)
})

test('/track right after the first row waits for the probes, so the sections never say "checking"', async ($, on) => {
  world(on, { acliProbeMs: 80 })
  await $.session.append(response('https://github.com/cli/cli/pull/14640 and https://acme.atlassian.net/browse/ISS-1'))
  const text = (await track($)).text ?? ''
  expect(text).not.toContain('checking')
  expect(text).toContain('ready')
})

test('/track clear empties the list; an unknown argument prints the usage', async ($, on) => {
  const { clock, calls, fake } = world(on)
  await $.session.append(response('https://one.example/'))
  fake.tools.Write = {
    type: 'create',
    filePath: '/work/docs/plan.md',
    content: '# Plan',
    structuredPatch: [],
    originalFile: null,
  }
  await $.tool.call({ tool: 'Write', file_path: '/work/docs/plan.md', content: '# Plan' } as never)
  expect((await track($)).text).toContain('one.example')
  expect((await track($)).text).toContain('plan.md  /work/docs')
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
  reasons: reasonsOfSources(['response']),
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
})
const KEPT = webRec('https://kept.example/', 'Kept page')

test('/clear while a flush is still pending: the items are saved under the old id and carried over', async ($, on) => {
  const { clock, store, calls } = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/')) // the flush is due in flushMs
  await clearSession($, { calls }, 'sess-2', 'clear') // /clear: a new id and an empty state, before the flush ran
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect((store.get('v2:s:' + SESSION) as { items: unknown[] } | undefined)?.items.length).toBe(1)
  expect((store.get('v2:s:sess-2') as { items: unknown[] } | undefined)?.items.length).toBe(1) // the same flush copies the carried list
  expect((await track($)).text).toContain('one.example')
})

test('the tick notices /clear and brings the items back while the pane is open', async ($, on) => {
  const { clock, calls, states } = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await track($) // opens the pane and starts the tick
  await clearSession($, { calls }, 'sess-2', 'clear', { row: false }) // /clear: the command row has no args, so no capture runs
  await clock.advance(LIMITS.tickMs + 10)
  const carried = () => (states.get('sess-2|artifact-tracking|items|')?.value as unknown[] | undefined)?.length === 1
  await until(carried, 'the tick to carry the items into sess-2') // the beat runs on its own, not inside advance()
  const ui = await mountPane($)
  expect(await ui.find({ text: 'one.example' })).toBeDefined()
  await ui.unmount()
})

test('/resume of a known session restores that session, not the one just left', async ($, on) => {
  const { store, calls } = world(on, {
    isolateState: true,
    seed: { 'v2:index': ['sess-b'], 'v2:s:sess-b': { items: [webRec('https://beta.example/', 'beta.example')] } },
    messages: [{ role: 'assistant', text: 'see https://transcript.example/t', toolUses: [] }],
  })
  await $.session.append(response('https://alpha.example/'))
  await clearSession($, { calls }, 'sess-b', 'resume') // /resume
  const text = (await track($)).text ?? ''
  expect(text).toContain('beta.example')
  expect(text).toContain('transcript.example') // the backfill runs, as at startup
  expect(text).not.toContain('alpha.example')
  expect((store.get('v2:s:' + SESSION) as { items: unknown[] }).items.length).toBe(1) // the left session is kept as it was
})

test('after /clear the tool statuses are published again', async ($, on) => {
  const { clock, calls, states } = world(on, { isolateState: true })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await clearSession($, { calls }, 'sess-2', 'clear')
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
  expect((store.get('v2:s:' + SESSION) as { items: unknown[] }).items.length).toBe(1)
  expect((await track($)).text).toContain('Web five')
})

// The check of a non-github host stays open until the test lets it go, so the test needs no clock: it checks the order,
// not the time. `session.start` must return while the check is open, and the late answer of the check must still count.
// A start that waits for the check only returns when the call times out (about 10 s). The check then has failed, the
// session has no repo, and the #N below stays unresolved. That is why the test ends on the late answer. The test is no
// speed guard: a start that waits a short while and then goes on passes it, because the kit has no clock that tells it
// from a fast start. The 30 s hang guard of `test` (fixtures/kit.ts) keeps the 10 s timeout of a real regression inside
// the limit of the test.
test('session.start does not wait for the check of a non-github host', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, calls, fake } = world(on, {
    remote: 'git@ghe.corp:acme/web.git',
    seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [KEPT] } },
  })
  fake.authHold = held
  try {
    await $.session.start(START) // returns while the check is open: only the release() below can end it
  } finally {
    release()
  }
  await quiet(calls)
  expect(calls).toContainEqual(['gh', 'auth', 'status', '--hostname', 'ghe.corp', '--json', 'hosts']) // the check ran, after the start
  await $.session.append(prompt('check issue #5')) // the late answer made ghe.corp the host: #5 now has a repo
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Kept page')
  expect(text).toContain('Web five')
})

test('session.start: keyworded #N from the transcript is resolved once the repo is known', async ($, on) => {
  const { clock, calls } = world(on, { messages: [{ role: 'user', text: 'please look at issue #5', toolUses: [] }] })
  await $.session.start(START)
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toContain('Web five')
})

test('session.start restores even when command.register is refused', async ($, on) => {
  world(on, { denyRegister: true, seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [KEPT] } } })
  await $.session.start(START)
  expect((await track($)).text).toContain('Kept page')
})

test('session.start restores a stored copy although the index lost its id', async ($, on) => {
  world(on, { seed: { 'v2:index': ['other'], ['v2:s:' + SESSION]: { items: [KEPT] } } })
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
  expect((store.get('v2:s:' + SESSION) as { items: unknown[] } | undefined)?.items.length).toBe(2)
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

// ---------------------------------------------------------------- priority keys

const ONE = 'web:https://one.example/'
const TWO = 'web:https://two.example/'
const JIRA_ROOT = 'jira:acme.atlassian.net/ISS-1'
const GH5 = 'gh:github.com/acme/web#5'

/** The line of the `/track` text that holds `s`. */
const lineOf = (text: string, s: string) => text.split('\n').findIndex(l => l.includes(s))
const storedItem = (store: Map<string, unknown>, key: string) =>
  (store.get('v2:s:' + SESSION) as { items: ItemRecord[] } | undefined)?.items.find(i => i.key === key)

/**
 * one.example, then two.example, captured, listed and flushed. `/track` kicks a run that arms a flush too, so wait
 * that one out as well: the next store write then comes from what the test does.
 */
async function twoLinks($: Engine, on: Parameters<typeof world>[0], opts: Parameters<typeof world>[1] = {}) {
  const w = world(on, opts)
  await $.session.append(response('See https://one.example/ and https://two.example/'))
  await w.clock.advance(LIMITS.flushMs + 10)
  await quiet(w.calls)
  await track($)
  await quiet(w.calls)
  await w.clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  return { ...w, ui: await mountPane($) }
}

test('pane: key 1 raises the focused row above its sibling and draws its marker', async ($, on) => {
  const { ui } = await twoLinks($, on)
  let text = (await track($)).text ?? ''
  expect(lineOf(text, 'one.example')).toBeLessThan(lineOf(text, 'two.example'))
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-1' })
  text = (await track($)).text ?? ''
  expect(lineOf(text, 'two.example')).toBeLessThan(lineOf(text, 'one.example'))
  expect(text).toContain('▲ two.example')
  expect(await ui.find({ text: '▲' })).toBeDefined()
  await ui.unmount()
})

test('pane: key 3 lowers the row, key 2 stores a manual normal, key 0 removes the mark', async ($, on) => {
  const { ui, clock, store } = await twoLinks($, on)
  await select($, ui, 'one.example')
  await ui.press({ key: 'prio-3' })
  let text = (await track($)).text ?? ''
  expect(lineOf(text, 'two.example')).toBeLessThan(lineOf(text, 'one.example'))
  expect(text).toContain('▽ one.example')
  await ui.press({ key: 'prio-2' })
  text = (await track($)).text ?? ''
  expect(lineOf(text, 'one.example')).toBeLessThan(lineOf(text, 'two.example'))
  expect(text).not.toContain('▽')
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  expect(storedItem(store, ONE)?.priority).toBe('normal')
  await ui.press({ key: 'prio-0' })
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  expect('priority' in (storedItem(store, ONE) ?? {})).toBe(false)
  await ui.unmount()
})

test('pane: the keys work on a Jira root, a Jira child and a GitHub row', async ($, on) => {
  const { clock, calls, store } = world(on)
  await $.session.append(prompt('Look at issue #5 and https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  await track($)
  await quiet(calls)
  const ui = await mountPane($)
  await select($, ui, 'ISS-1')
  await ui.press({ key: 'prio-1' })
  await select($, ui, 'PROJ-201')
  await ui.press({ key: 'prio-3' })
  await select($, ui, '#5')
  await ui.press({ key: 'prio-1' })
  await ui.press({ key: 'prio-0' })
  await ui.unmount()
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  const root = storedItem(store, JIRA_ROOT) as
    | (ItemRecord & { children: { key: string; priority?: string }[] })
    | undefined
  expect(root?.priority).toBe('high')
  expect(root?.children.map(c => [c.key, c.priority])).toEqual([
    ['PROJ-201', 'low'],
    ['PROJ-202', undefined],
  ])
  expect('priority' in (storedItem(store, GH5) ?? {})).toBe(false)
  const text = (await track($)).text ?? ''
  expect(text).toContain('▲ ISS-1')
  expect(lineOf(text, 'PROJ-202')).toBeLessThan(lineOf(text, 'PROJ-201')) // the child sorts inside its parent
  expect(lineOf(text, 'ISS-1')).toBeLessThan(lineOf(text, 'PROJ-202'))
})

test('pane: a raised priority reaches the stored copy with no other change in between', async ($, on) => {
  const { ui, clock, store } = await twoLinks($, on)
  expect('priority' in (storedItem(store, TWO) ?? {})).toBe(false)
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-1' })
  await ui.unmount()
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  expect(storedItem(store, TWO)?.priority).toBe('high')
})

test('pane: a refresh keeps the order the person set', async ($, on) => {
  const { ui } = await twoLinks($, on)
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-1' })
  await ui.unmount()
  const text = (await track($, 'refresh')).text ?? ''
  expect(lineOf(text, 'two.example')).toBeLessThan(lineOf(text, 'one.example'))
})

test('/track prio sets a level by ref and saves it before the reply, for claude -p', async ($, on) => {
  const { clock, calls, store } = world(on)
  await $.session.append(prompt('Look at issue #5 and https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  await track($)
  await quiet(calls)
  let text = (await track($, 'prio #5 high')).text ?? ''
  expect(text).toContain('▲ #5')
  expect(storedItem(store, GH5)?.priority).toBe('high') // no clock advance: the store has it already
  text = (await track($, 'prio ISS-1 LOW')).text ?? ''
  expect(text).toContain('▽ ISS-1')
  text = (await track($, 'prio proj-202 high')).text ?? '' // a Jira child, by its key, in any case
  expect(text).toContain('▲ PROJ-202')
  expect(lineOf(text, 'PROJ-202')).toBeLessThan(lineOf(text, 'PROJ-201'))
  text = (await track($, 'prio https://github.com/acme/web/issues/5 auto')).text ?? ''
  expect(text).not.toContain('▲ #5')
  expect('priority' in (storedItem(store, GH5) ?? {})).toBe(false)
})

test('/track prio: an untracked ref says so; a bad level or a missing part prints the usage', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('Look at issue #5'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  expect((await track($, 'prio #99 high')).text).toBe('Not tracked: #99')
  expect((await track($, 'prio #5 urgent')).text).toContain(
    'Usage: /track [refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <high|normal|low|auto>]',
  )
  expect((await track($, 'prio #5')).text).toContain('Usage: /track')
  expect((await track($)).text).not.toContain('▲')
})

// ---------------------------------------------------------------- priority across /clear, restart and re-track

test('/clear carries a mark into the new session, and the new copy holds it', async ($, on) => {
  const { ui, clock, store, calls } = await twoLinks($, on, { isolateState: true })
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-1' })
  await ui.unmount()
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  await clearSession($, { calls }, 'sess-2', 'clear') // /clear: a new id and an empty state
  const text = (await track($)).text ?? ''
  expect(text).toContain('▲ two.example')
  expect(lineOf(text, 'two.example')).toBeLessThan(lineOf(text, 'one.example'))
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  const copy = store.get('v2:s:sess-2') as { items: ItemRecord[] }
  expect(copy.items.find(i => i.key === TWO)?.priority).toBe('high')
})

test('/clear right after a reset keeps no mark: the live list wins over the older stored copy', async ($, on) => {
  const { ui, clock, store, calls } = await twoLinks($, on, { isolateState: true })
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-1' })
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  expect(storedItem(store, TWO)?.priority).toBe('high')
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-0' }) // the flush of this change has not run yet
  await ui.unmount()
  await clearSession($, { calls }, 'sess-2', 'clear')
  expect((await track($)).text).not.toContain('▲')
})

test('x then /clear: the dismissed item stays gone, also before its flush ran', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.start(START) // pins the run's root, so the dismiss list outlives /clear
  await $.session.append(response('See https://one.example/ and https://two.example/'))
  await w.clock.advance(LIMITS.flushMs + 10)
  await quiet(w.calls)
  await sleep(20)
  await track($)
  const ui = await mountPane($)
  await select($, ui, 'two.example')
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  await clearSession($, w, 'sess-2', 'clear')
  const text = (await track($)).text ?? ''
  expect(text).toContain('one.example')
  expect(text).not.toContain('two.example')
})

test('the x key saves the shorter list soon, with no other change', async ($, on) => {
  const { ui, clock, store } = await twoLinks($, on)
  expect(storedItem(store, TWO)).toBeDefined()
  await select($, ui, 'two.example')
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  expect(storedItem(store, TWO)).toBeUndefined()
})

test('session.start restores the marks of a stored copy and sorts by them', async ($, on) => {
  const seed = { items: [webRec('https://other.example/', 'other'), { ...KEPT, priority: 'high' }] }
  world(on, { seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: seed } })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toContain('▲ Kept page')
  expect(lineOf(text, 'Kept page')).toBeLessThan(lineOf(text, 'other'))
})

test('an item tracked again after /track clear starts with no mark', async ($, on) => {
  const { ui, clock, calls } = await twoLinks($, on)
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-1' })
  await ui.unmount()
  expect((await track($, 'clear')).text).toBe('Tracking list cleared.')
  await $.session.append(response('Again https://two.example/'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('two.example')
  expect(text).not.toContain('▲')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane: the marker of a high and a low row is drawn (${surface})`, async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.append(response('See https://one.example/'))
    await clock.advance(LIMITS.captureDebounceMs + 10)
    await quiet(calls)
    await track($)
    const ui = await mountPane($, { surface })
    expect(await ui.find({ text: '▲' })).toBeUndefined()
    await select($, ui, 'one.example')
    await ui.press({ key: 'prio-1' })
    expect(await ui.find({ text: '▲' })).toBeDefined()
    await select($, ui, 'one.example') // the selection is by row id, so the row keeps it after the move
    await ui.press({ key: 'prio-3' })
    expect(await ui.find({ text: '▽' })).toBeDefined()
    expect(await ui.find({ text: '▲' })).toBeUndefined()
    await ui.unmount()
  })
}

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
  await clearSession($, { calls }, 'sess-2', 'clear', { row: false }) // /clear: new id, empty state, session repo forgotten
  await clock.advance(LIMITS.tickMs + 10)
  await quiet(calls)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'Web five' })).toBeDefined()
  expect(await ui.find({ text: 'acme/web#5' })).toBeUndefined()
  await ui.unmount()
})

test('repos: a repo found by a Bash cd is stored after the flush delay, without any other update', async ($, on) => {
  const { clock, store, calls, fake } = world(on)
  await $.session.start(START) // pins the root (/work), so the tracker knows which repo is its own
  fake.run = argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C' || argv[2] !== '/x/sdk') return undefined
    if (argv[3] === 'rev-parse') return res('/x/sdk\n/x/sdk/.git\n')
    if (argv[3] === 'remote') return res('git@github.com:acme/sdk.git\n')
    return res('main\n')
  }
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 'toolu_cd_1' } as never)
  await quiet(calls)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  const saved = store.get('v2:s:' + SESSION) as { repos?: { key: string }[] } | undefined
  expect(saved?.repos?.map(r => r.key)).toEqual(['remote:github.com/acme/sdk'])
})

test('repos: a Bash cd inside the session root adds no Repos row', async ($, on) => {
  const { clock, store, calls, fake } = world(on)
  await $.session.start(START)
  fake.run = argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C' || !String(argv[2]).startsWith('/work')) return undefined
    if (argv[3] === 'rev-parse') return res('/work\n/work/.git\n')
    if (argv[3] === 'remote') return res('git@gitlab.com:grp/app.git\n')
    return res('main\n')
  }
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd /work/src && ls', tool_use_id: 'toolu_cd_2' } as never)
  await quiet(calls)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  const saved = store.get('v2:s:' + SESSION) as { repos?: { key: string }[] } | undefined
  expect(saved?.repos ?? []).toEqual([])
})

// ---------------------------------------------------------------- repos: store, restore, carry-over, clear

const SDK_KEY = 'remote:github.com/acme/sdk'
const STORED_SDK = {
  key: SDK_KEY,
  name: 'acme/sdk',
  root: '/x/sdk',
  branch: 'old',
  touchedBy: ['main', 'planner'],
  firstSeen: 10,
  lastSeen: 50,
}
type SavedRepos = { repos?: { key: string; firstSeen: number; branch?: string; touchedBy: string[] }[] }

type GitRes = ReturnType<typeof res>
function sdkGit(
  fake: { run: ((argv: string[]) => GitRes | undefined | Promise<GitRes | undefined>) | undefined },
  branch = 'new',
) {
  fake.run = argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C' || argv[2] !== '/x/sdk') return undefined
    if (argv[3] === 'rev-parse') return res('/x/sdk\n/x/sdk/.git\n')
    if (argv[3] === 'remote') return res('git@github.com:acme/sdk.git\n')
    return res(branch + '\n')
  }
}

test('repos: a restored stored row keeps its firstSeen and every agent', async ($, on) => {
  const { clock, store, calls } = world(on, {
    seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [], repos: [STORED_SDK] } },
  })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toContain('acme/sdk')
  expect(text).toContain('main, planner')
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  const saved = store.get('v2:s:' + SESSION) as SavedRepos
  expect(saved.repos?.[0]).toMatchObject({ key: SDK_KEY, firstSeen: 10, touchedBy: ['main', 'planner'] })
})

test('repos: /resume does not let the older stored branch overwrite a live row', async ($, on) => {
  // No isolateState: the kit keeps the live rows across the id change, so the restore merges into them.
  const { calls, fake } = world(on, {
    seed: { 'v2:index': ['sess-b'], 'v2:s:sess-b': { items: [], repos: [STORED_SDK] } },
  })
  await $.session.start(START)
  sdkGit(fake, 'new')
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 'toolu_cd_r1' } as never)
  await quiet(calls)
  await clearSession($, { calls }, 'sess-b', 'resume') // /resume: the store knows sess-b, so its copy is restored over the live rows
  const text = (await track($)).text ?? ''
  expect(text).toContain('new')
  expect(text).not.toContain('old')
  expect(text).toContain('main, planner')
})

test('repos: /clear carries the repo rows over to the new session', async ($, on) => {
  const { clock, store, calls, fake } = world(on, { isolateState: true })
  await $.session.start(START)
  sdkGit(fake)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 'toolu_cd_c1' } as never)
  await quiet(calls)
  await clearSession($, { calls }, 'sess-2', 'clear') // /clear: new id, empty state
  await track($)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect((await track($)).text ?? '').toContain('acme/sdk')
  const saved = store.get('v2:s:sess-2') as SavedRepos | undefined
  expect(saved?.repos?.map(r => r.key)).toEqual([SDK_KEY])
})

test('repos: /track clear empties the rows, deletes the stored copy and a later flush writes nothing', async ($, on) => {
  const { clock, store, calls, fake } = world(on)
  await $.session.start(START)
  sdkGit(fake)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 'toolu_cd_x1' } as never)
  await quiet(calls)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  expect(store.has('v2:s:' + SESSION)).toBe(true)
  await track($, 'clear')
  expect(store.has('v2:s:' + SESSION)).toBe(false)
  expect((await track($)).text).toBe('No tracked items yet.')
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect(store.has('v2:s:' + SESSION)).toBe(false)
})

test('repos: a second visit of the same repo a moment later makes no new repos write', async ($, on) => {
  const { calls, fake } = world(on, { isolateState: true })
  await $.session.start(START)
  sdkGit(fake)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 'toolu_cd_w1' } as never)
  await quiet(calls)
  const writes = fake.stateSets.repos
  expect(writes).toBeGreaterThan(0)
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 'toolu_cd_w2' } as never)
  await quiet(calls)
  expect(fake.stateSets.repos).toBe(writes)
})

// ---------------------------------------------------------------- repos: file tools, off the hook path

type Fake = ReturnType<typeof world>['fake']
const SDK_REMOTE = 'git@github.com:acme/sdk.git'
const LIB_REMOTE = 'git@github.com:acme/lib.git'
const RAN = { stdout: '', stderr: '', interrupted: false }

/**
 * Git answers for repos at the given tops (top to remote). Every git call takes a few ms, so overlapping calls show in
 * `seen.peak`. `held` makes a rev-parse wait for a promise that the test releases.
 */
function gitAt(fake: Fake, tops: Record<string, string>, held?: Promise<undefined>) {
  const seen = { revParse: [] as string[], branchCalls: 0, branch: 'main', inFlight: 0, peak: 0 }
  fake.run = async argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C') return undefined
    const dir = String(argv[2])
    const top = Object.keys(tops).find(t => dir === t || dir.startsWith(t + '/'))
    if (top === undefined) return undefined
    if (argv[3] === 'rev-parse') {
      seen.revParse.push(dir)
      if (held) await held
    }
    seen.inFlight++
    seen.peak = Math.max(seen.peak, seen.inFlight)
    try {
      await sleep(3)
    } finally {
      seen.inFlight--
    }
    if (argv[3] === 'rev-parse') return res(`${top}\n${top}/.git\n`)
    if (argv[3] === 'remote') return res(tops[top] + '\n')
    if (argv[3] === 'branch') seen.branchCalls++
    return res(`${seen.branch}\n`)
  }
  return seen
}

const holdOne = () => {
  let release: () => void = () => {}
  const held = new Promise<undefined>(resolve => {
    release = () => resolve(undefined)
  })
  return { held, release }
}

/** Waits for the queue, the flush delay and the write. */
async function drain(w: ReturnType<typeof world>): Promise<void> {
  await quiet(w.calls)
  await w.clock.advance(LIMITS.flushMs + 10)
  await quiet(w.calls)
  await sleep(20)
}

const savedKeys = (w: ReturnType<typeof world>): string[] =>
  ((w.store.get('v2:s:' + SESSION) as SavedRepos | undefined)?.repos ?? []).map(r => r.key)

test('repos: a file tool returns before the repo lookup ends', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const { held, release } = holdOne()
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE }, held)
  w.fake.tools.Read = { type: 'text' }
  try {
    const out = await Promise.race([
      $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't1' } as never),
      sleep(200).then(() => 'blocked'),
    ])
    expect(out).not.toBe('blocked')
  } finally {
    release()
  }
  await drain(w)
})

for (const [tool, field] of [
  ['Read', 'file_path'],
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
  ['Grep', 'path'],
  ['Glob', 'path'],
] as const) {
  test(`repos: a ${tool} of a file in another repo adds the repo row`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
    w.fake.tools[tool] = RAN
    await $.tool.call({ tool, [field]: '/x/sdk/src/a.ts', tool_use_id: 't1' } as never)
    await drain(w)
    expect(savedKeys(w)).toEqual([SDK_KEY])
    expect((w.store.get('v2:s:' + SESSION) as SavedRepos).repos?.[0]?.touchedBy).toEqual(['main'])
  })
}

const savedMode = (w: ReturnType<typeof world>): string | undefined =>
  (w.store.get('v2:s:' + SESSION) as { repos?: { mode?: string }[] } | undefined)?.repos?.[0]?.mode

test('repos: a Read then an Edit in one repo store mode edit', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.tools.Read = RAN
  w.fake.tools.Edit = RAN
  await $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't1' } as never)
  await quiet(w.calls)
  await $.tool.call({ tool: 'Edit', file_path: '/x/sdk/a.ts', tool_use_id: 't2' } as never)
  await drain(w)
  expect(savedMode(w)).toBe('edit')
})

test('repos: an Edit then a Read in one repo keep mode edit', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.tools.Read = RAN
  w.fake.tools.Edit = RAN
  await $.tool.call({ tool: 'Edit', file_path: '/x/sdk/a.ts', tool_use_id: 't1' } as never)
  await quiet(w.calls)
  await $.tool.call({ tool: 'Read', file_path: '/x/sdk/b.ts', tool_use_id: 't2' } as never)
  await drain(w)
  expect(savedMode(w)).toBe('edit')
})

test('repos: a Read alone stores mode read, and a Bash git -C commit then stores edit', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.tools.Read = RAN
  w.fake.tools.Bash = RAN
  await $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't1' } as never)
  await drain(w)
  expect(savedMode(w)).toBe('read')
  await $.tool.call({ tool: 'Bash', command: 'git -C /x/sdk commit -m m', tool_use_id: 't2' } as never)
  await drain(w)
  expect(savedMode(w)).toBe('edit')
})

test('repos: a Bash git -C checkout re-reads the branch at once, a git status keeps the cached one', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const seen = gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.tools.Bash = RAN
  const branchOf = () => (w.store.get('v2:s:' + SESSION) as SavedRepos | undefined)?.repos?.[0]?.branch
  await $.tool.call({ tool: 'Bash', command: 'git -C /x/sdk status', tool_use_id: 't1' } as never)
  await drain(w)
  expect(branchOf()).toBe('main')
  expect(seen.branchCalls).toBe(1)

  seen.branch = 'feat'
  await $.tool.call({ tool: 'Bash', command: 'git -C /x/sdk log', tool_use_id: 't2' } as never)
  await drain(w)
  expect(branchOf()).toBe('main')
  expect(seen.branchCalls).toBe(1)

  await $.tool.call({ tool: 'Bash', command: 'git -C /x/sdk checkout feat', tool_use_id: 't3' } as never)
  await drain(w)
  expect(branchOf()).toBe('feat')
  expect(seen.branchCalls).toBe(2)
})

test('repos: a main-loop Read with a relative file_path resolves from the session cwd', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.cwd = '/x/sdk'
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.tools.Read = RAN
  await $.tool.call({ tool: 'Read', file_path: 'src/a.ts', tool_use_id: 't1' } as never)
  await drain(w)
  expect(savedKeys(w)).toEqual([SDK_KEY])
})

test('repos: a subagent Read with a relative file_path adds no row and runs no rev-parse', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.cwd = '/x/sdk'
  const seen = gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.tools.Read = RAN
  await $.tool.call({ tool: 'Read', file_path: 'src/a.ts', agentId: 'a1', tool_use_id: 't1' } as never)
  await drain(w)
  expect(seen.revParse).toEqual([])
  expect(savedKeys(w)).toEqual([])
})

test('repos: a Read of a file in /tmp adds no row', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  gitAt(w.fake, { '/tmp': SDK_REMOTE })
  w.fake.tools.Read = RAN
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x', tool_use_id: 't1' } as never)
  await drain(w)
  expect(savedKeys(w)).toEqual([])
})

test('repos: two Reads at once in one repo look it up once, and the lookups of two repos never overlap', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const seen = gitAt(w.fake, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE })
  w.fake.tools.Read = RAN
  await Promise.all([
    $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't1' } as never),
    $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't2' } as never),
    $.tool.call({ tool: 'Read', file_path: '/x/lib/b.ts', tool_use_id: 't3' } as never),
  ])
  await drain(w)
  expect(seen.revParse.filter(d => d.startsWith('/x/sdk'))).toHaveLength(1)
  expect(seen.peak).toBe(1)
  expect(savedKeys(w).sort()).toEqual(['remote:github.com/acme/lib', SDK_KEY])
})

test('repos: a denied or failed file tool adds no row', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const seen = gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.toolAnswers.Read = { deny: 'no' }
  await $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't1' } as never)
  w.fake.toolAnswers.Read = { isError: true, result: 'ENOENT', text: 'ENOENT' }
  await $.tool.call({ tool: 'Read', file_path: '/x/sdk/b.ts', tool_use_id: 't2' } as never)
  await drain(w)
  expect(seen.revParse).toEqual([])
  expect(savedKeys(w)).toEqual([])
})

test('repos: a denied Bash cd adds no row, a failing one does', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const seen = gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.toolAnswers.Bash = { deny: 'no' }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk', tool_use_id: 't1' } as never)
  await drain(w)
  expect(seen.revParse).toEqual([])
  expect(savedKeys(w)).toEqual([])
  w.fake.toolAnswers.Bash = { isError: true, result: 'exit 1', text: 'exit 1' }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && false', tool_use_id: 't2' } as never)
  await drain(w)
  expect(savedKeys(w)).toEqual([SDK_KEY])
})

test('repos: a tool outside the path tools makes no git call', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const seen = gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  await $.tool.call({ tool: 'Skill', file_path: '/x/sdk/a', tool_use_id: 't1' } as never)
  await drain(w)
  expect(seen.revParse).toEqual([])
  expect(savedKeys(w)).toEqual([])
})

// A persisted `cd` moves the session cwd while the tool runs. The hook must resolve the command from the cwd it had before.
test('repos: a relative cd in Bash resolves from the cwd before the command, not after it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.cwd = '/w/repo'
  gitAt(w.fake, { '/w/other/sdk': SDK_REMOTE })
  Object.defineProperty(w.fake.tools, 'Bash', {
    configurable: true,
    get() {
      w.fake.cwd = '/w/other/sdk' // the persisted cd
      return RAN
    },
  })
  await $.tool.call({ tool: 'Bash', command: 'cd ../other/sdk && ls', tool_use_id: 't1' } as never)
  await drain(w)
  expect(savedKeys(w)).toEqual([SDK_KEY])
})

test('repos: pushd and git -c .. -C with a relative path resolve from the session cwd', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.cwd = '/w/repo'
  gitAt(w.fake, { '/w/sdk': SDK_REMOTE, '/w/lib': LIB_REMOTE })
  w.fake.tools.Bash = RAN
  await $.tool.call({ tool: 'Bash', command: 'pushd ../sdk', tool_use_id: 't1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -c a=b -C ../lib status', tool_use_id: 't2' } as never)
  await drain(w)
  expect(savedKeys(w).sort()).toEqual(['remote:github.com/acme/lib', SDK_KEY])
})

// ---------------------------------------------------------------- repos: agent.spawn cwd and the touchedBy label

test('repos: a workflow agent.spawn cwd in another repo adds a row labelled with the agent', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.spawnId = 'w1'
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  await $.agent.spawn({ ...ev.WORKFLOW_SPAWN_INPUT, cwd: '/x/sdk' } as never)
  await drain(w)
  const rows = (w.store.get('v2:s:' + SESSION) as SavedRepos).repos ?? []
  expect(rows.map(r => [r.key, r.touchedBy])).toEqual([[SDK_KEY, ['architect']]])
})

test('repos: a spawn with no name, description or type is labelled agent:<first 8 of the id>', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.spawnId = 'abcdefghij'
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  await $.agent.spawn({
    ...ev.WORKFLOW_SPAWN_INPUT,
    name: '',
    description: '',
    subagentType: '',
    cwd: '/x/sdk',
  } as never)
  await drain(w)
  const rows = (w.store.get('v2:s:' + SESSION) as SavedRepos).repos ?? []
  expect(rows.map(r => r.touchedBy)).toEqual([['agent:abcdefgh']])
})

test('repos: the main loop and a spawned agent share one row', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.spawnId = 'w1'
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.tools.Bash = RAN
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 't1' } as never)
  await drain(w)
  await $.agent.spawn({ ...ev.WORKFLOW_SPAWN_INPUT, cwd: '/x/sdk' } as never)
  await drain(w)
  const rows = (w.store.get('v2:s:' + SESSION) as SavedRepos).repos ?? []
  expect(rows.map(r => [r.key, r.touchedBy])).toEqual([[SDK_KEY, ['main', 'architect']]])
})

test('repos: a nested child with no cwd gets the cwd of its parent and adds a row', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  w.fake.spawnId = 'w1'
  await $.agent.spawn({ ...ev.WORKFLOW_SPAWN_INPUT, cwd: '/x/sdk' } as never)
  w.fake.spawnId = 'w2'
  await $.agent.spawn({
    ...ev.WORKFLOW_SPAWN_INPUT,
    parentAgentId: 'w1',
    description: 'child',
    name: '',
    cwd: undefined,
  } as never)
  await drain(w)
  const rows = (w.store.get('v2:s:' + SESSION) as SavedRepos).repos ?? []
  expect(rows.map(r => [r.key, r.touchedBy])).toEqual([[SDK_KEY, ['architect', 'child']]])
})

test('repos: a spawn in the root folder or with no cwd adds no row', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.spawnId = 'w1'
  const seen = gitAt(w.fake, { '/x/sdk': SDK_REMOTE })
  await $.agent.spawn({ ...ev.WORKFLOW_SPAWN_INPUT, cwd: '/work' } as never)
  w.fake.spawnId = 'w2'
  await $.agent.spawn({ ...ev.WORKFLOW_SPAWN_INPUT, cwd: undefined } as never)
  await drain(w)
  expect(seen.revParse).toEqual([])
  expect(savedKeys(w)).toEqual([])
})

// ---------------------------------------------------------------- repos: /track clear while a lookup waits

test('repos: a lookup that ends after /track clear leaves no row', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const { held, release } = holdOne()
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE }, held)
  w.fake.tools.Bash = RAN
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: 't1' } as never)
  await sleep(30) // the job waits on git
  await track($, 'clear')
  release()
  await drain(w)
  expect(savedKeys(w)).toEqual([])
  expect(w.store.has('v2:s:' + SESSION)).toBe(false)
  expect((await track($)).text).toBe('No tracked items yet.')
})

test('repos: a visit that waits in the queue during /track clear does not swallow the same visit made after it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const { held, release } = holdOne()
  gitAt(w.fake, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE }, held)
  w.fake.tools.Read = RAN
  // The lib job runs and waits on git. The first sdk visit waits behind it in the queue.
  await $.tool.call({ tool: 'Read', file_path: '/x/lib/b.ts', tool_use_id: 't1' } as never)
  await sleep(30)
  await $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't2' } as never)
  await track($, 'clear')
  await $.tool.call({ tool: 'Read', file_path: '/x/sdk/a.ts', tool_use_id: 't3' } as never)
  release()
  await drain(w)
  expect(savedKeys(w)).toEqual([SDK_KEY])
})

test('repos: restoring more than maxRepos stored rows keeps maxRepos', async ($, on) => {
  const rows = Array.from({ length: LIMITS.maxRepos + 1 }, (_, i) => ({
    ...STORED_SDK,
    key: `local:/r${i}`,
    name: `r${i}`,
    lastSeen: 100 + i,
  }))
  const { clock, store, calls } = world(on, {
    seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [], repos: rows } },
  })
  await $.session.start(START)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  const saved = store.get('v2:s:' + SESSION) as SavedRepos
  expect(saved.repos).toHaveLength(LIMITS.maxRepos)
  expect(saved.repos?.map(r => r.key)).not.toContain('local:/r0')
})

// ---------------------------------------------------------------- repos: dismiss with the x button

/** A Bash `cd` into the sdk repo, the queue drained. */
async function visitSdk($: Engine, w: ReturnType<typeof world>, id: string): Promise<void> {
  sdkGit(w.fake)
  w.fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls', tool_use_id: id } as never)
  await quiet(w.calls)
}

async function dismissSdk($: Engine): Promise<void> {
  const ui = await mountPane($)
  await select($, ui, 'sdk')
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
}

const bandHas = async ($: Engine, text: string): Promise<boolean> => {
  const ui = (await $.ui.mount({ ...BAND, surface: 'terminal' } as never)) as unknown as {
    find(q: unknown): Promise<unknown>
    unmount(): Promise<void>
  }
  const found = (await ui.find({ text })) !== undefined
  await ui.unmount()
  return found
}

test('repos dismiss: the x key hides the row from /track and the band', async ($, on) => {
  const w = world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.session.start(START)
  await visitSdk($, w, 'toolu_dm_1')
  expect((await track($)).text ?? '').toContain('acme/sdk')
  expect(await bandHas($, 'Repos 1')).toBe(true)
  await dismissSdk($)
  await quiet(w.calls)
  expect((await track($)).text ?? '').not.toContain('Repos')
  expect(await bandHas($, 'Repos')).toBe(false)
})

test('repos dismiss: a later visit of the dismissed repo adds no row, a flush stores none', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await visitSdk($, w, 'toolu_dm_2')
  await dismissSdk($)
  await visitSdk($, w, 'toolu_dm_3')
  await drain(w)
  expect((await track($)).text ?? '').not.toContain('acme/sdk')
  expect(savedKeys(w)).not.toContain(SDK_KEY)
})

test('repos dismiss: a restore of a stored copy that holds the dismissed repo keeps it hidden', async ($, on) => {
  const w = world(on, { seed: { 'v2:index': ['sess-b'], 'v2:s:sess-b': { items: [], repos: [STORED_SDK] } } })
  await $.session.start(START)
  await visitSdk($, w, 'toolu_dm_4')
  await dismissSdk($)
  await clearSession($, w, 'sess-b', 'resume') // /resume: the stored copy still holds the repo
  expect((await track($)).text ?? '').not.toContain('acme/sdk')
})

test('repos dismiss: /clear carry-over keeps the dismissed repo hidden', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.start(START)
  await visitSdk($, w, 'toolu_dm_5')
  await dismissSdk($)
  await clearSession($, w, 'sess-2', 'clear') // /clear
  expect((await track($)).text ?? '').not.toContain('acme/sdk')
})

test('repos dismiss: another repo touched after the dismiss still appears', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await visitSdk($, w, 'toolu_dm_6')
  await dismissSdk($)
  const git = w.fake.run
  w.fake.run = argv => {
    if (argv[0] === 'git' && argv[2] === '/x/lib') {
      if (argv[3] === 'rev-parse') return res('/x/lib\n/x/lib/.git\n')
      if (argv[3] === 'remote') return res('git@github.com:acme/lib.git\n')
      return res('main\n')
    }
    return git?.(argv)
  }
  await $.tool.call({ tool: 'Bash', command: 'cd /x/lib && ls', tool_use_id: 'toolu_dm_7' } as never)
  await quiet(w.calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('acme/lib')
  expect(text).not.toContain('acme/sdk')
})

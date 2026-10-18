// The capture funnel of the item runtime on fakePorts: the door rules of the four rows that carry text, the open check
// of short refs and the Jira site filter. Each case mirrors the kit test of the same subject in register.test.tsx.
// Plan: L3 Task 11.
import { expect, test } from 'claude-code/testing'
import type { ItemRecord } from '../hooks/contracts'
import { Capture, filterToolRefsForSite, keepOpenSessionShortRefs, PERSON } from '../hooks/items/capture'
import { commandRow, graphqlCalls, itemsWorld, promptRow, responseRow, toolResultRow } from './fixtures/items'

test('a prompt row with #5 and a Jira URL tracks both; the short ref is checked first', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('Look at issue #5 and https://acme.atlassian.net/browse/ISS-1'))
  expect(t.keys().sort()).toEqual(['gh:github.com/acme/web#5', 'jira:acme.atlassian.net/ISS-1'])
  expect(graphqlCalls(t.w.calls).length).toBe(1) // the open check of #5
  expect(t.persisted).toContain('items')
})

test('keyworded short refs are kept only when the item exists and is open', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('Check issue #5 and issue #404'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
})

test('a short ref is dropped when gh is missing', async () => {
  const t = itemsWorld({ run: argv => (argv[0] === 'gh' ? { exitCode: 127, stdout: '', stderr: 'nope' } : undefined) })
  const rt = await t.started()
  await rt.capture(promptRow('Check issue #5 and https://github.com/cli/cli/pull/14640'))
  expect(t.keys()).toEqual(['gh:github.com/cli/cli#14640'])
})

test('rows of other makers are not captured: task notification, isMeta, subagent, coordinator', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('done: https://github.com/cli/cli/pull/14640 and #5', 'task-notification'))
  await rt.capture(promptRow('see https://acme.atlassian.net/browse/ISS-2', 'composer', { isMeta: true }))
  await rt.capture(promptRow('see https://acme.atlassian.net/browse/ISS-3', 'composer', { agentId: 'agent-7' }))
  await rt.capture(promptRow('go and read #6', 'coordinator'))
  expect(t.keys()).toEqual([])
  expect(graphqlCalls(t.w.calls).length).toBe(0)
  expect([...PERSON].sort()).toEqual(['bridge', 'composer', 'sdk', 'unclassified'])
})

test('a row with no message and a door with no text rule capture nothing', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/cli/cli/pull/14640', 'composer', { hasMessage: false }))
  await rt.capture({
    door: 'note',
    origin: 'composer',
    isMeta: false,
    hasMessage: true,
    text: 'https://github.com/cli/cli/pull/14640',
  })
  expect(t.keys()).toEqual([])
})

test('command rows: our own engine output is skipped, a composer command is read from its args', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(commandRow('<command-name>/track</command-name>\n<command-args>#77</command-args>', 'engine'))
  await rt.capture(
    commandRow('<local-command-stdout>Jira  ISS-77  #77 https://leak.example/x</local-command-stdout>', 'engine'),
  )
  await rt.capture(
    commandRow(
      '<command-message>foo</command-message>\n<command-name>/foo https://outside.example/o</command-name>\n<command-args>issue #9</command-args>',
      'composer',
    ),
  )
  expect(t.keys()).toEqual(['gh:github.com/acme/web#9'])
})

test('a command with no args captures nothing', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(commandRow('<command-name>/clear</command-name>', 'composer'))
  expect(t.keys()).toEqual([])
})

test('tool-result rows keep explicit GitHub and Jira URLs only, never bare #N or web links', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(toolResultRow('see https://example.com and #7, build #8 failed'))
  expect(t.keys()).toEqual([])
  await rt.capture(toolResultRow('opened https://github.com/cli/cli/pull/14640 just now'))
  expect(t.keys()).toEqual(['gh:github.com/cli/cli#14640'])
})

test('a Jira URL of a foreign site in tool output is skipped', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(
    toolResultRow(
      "expect(root!.href).toBe('https://acme.atlassian.net/browse/ISS-101')\nsee https://vertice.atlassian.net/browse/ISS-2",
    ),
  )
  expect(t.keys()).toEqual(['jira:acme.atlassian.net/ISS-101'])
})

test('with no active Jira site every Jira ref of tool output is dropped', () => {
  const refs = [
    { category: 'jira', site: 'a.atlassian.net', issueKey: 'A-1', url: 'u', trackOnly: false },
    { category: 'web', url: 'https://x.example/', label: 'x' },
  ] as const
  expect(filterToolRefsForSite([...refs], null).map(r => r.category)).toEqual(['web'])
  expect(filterToolRefsForSite([...refs], undefined).length).toBe(2)
  expect(filterToolRefsForSite([...refs], 'A.atlassian.net').length).toBe(2)
  expect(filterToolRefsForSite([refs[1]], null).length).toBe(1)
})

test('a response row captures a web link and a PR URL', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(
    responseRow('See [the docs](https://code.claude.com/docs/en/plugins) and https://github.com/cli/cli/pull/14640.'),
  )
  expect(t.keys().sort()).toEqual(['gh:github.com/cli/cli#14640', 'web:https://code.claude.com/docs/en/plugins'])
})

test('a URL and a bare #N for the same item make one item', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('check issue #5'))
  await rt.capture(responseRow('Fixed https://github.com/acme/web/issues/5 already.'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  expect(((t.list()[0] as ItemRecord).sources as string[]).sort()).toEqual(['prompt', 'response'])
})

test('a dismissed key is not captured again', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  t.dismissed.add('gh:github.com/cli/cli#14640')
  await rt.capture(responseRow('https://github.com/cli/cli/pull/14640 and https://docs.example/a'))
  expect(t.keys()).toEqual(['web:https://docs.example/a'])
})

test('a prompt that names an existing .md file adds a mentioned file row', async () => {
  const t = itemsWorld()
  t.w.files['/work/plan.md'] = '# plan'
  const rt = await t.started()
  await rt.capture(promptRow('please read plan.md'))
  expect(t.keys()).toEqual(['file:/work/plan.md'])
})

test('the open check of short refs: with no probe every same-repo ref goes, other refs stay', async () => {
  const same = {
    category: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: 5,
    type: 'unknown',
    short: true,
  } as const
  const other = { ...same, owner: 'cli', repo: 'cli' }
  const repo = { host: 'github.com', owner: 'acme', repo: 'web' }
  const kept = await keepOpenSessionShortRefs({ repo: () => repo, gh: () => undefined }, [same, other])
  expect(kept).toEqual([other])
  const none = await keepOpenSessionShortRefs({ repo: () => null, gh: () => undefined }, [same])
  expect(none).toEqual([same])
})

test('Capture.text ignores an empty text', async () => {
  const t = itemsWorld()
  const funnel = new Capture({
    repo: () => null,
    hosts: () => [],
    ensureRepo: async () => {},
    site: async () => undefined,
    gh: () => undefined,
    items: { update: async () => false, trackRefs: async () => {} },
    files: () => undefined,
  })
  await funnel.text('', 'full', 'prompt')
  await funnel.text('see https://github.com/cli/cli/pull/14640', 'full', 'prompt')
  expect(t.keys()).toEqual([])
})

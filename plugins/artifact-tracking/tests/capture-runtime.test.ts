// The capture of the item service on fakePorts: the door rules of the rows that carry text, the open check of short refs,
// the Jira site filter, and the items of a replayed transcript (the backfill rules per role, what a stored key keeps,
// what only the transcript may know of an artifact, and the dismissed keys). The cases of the L3 capture and replay
// tests moved here; each mirrors the kit test of the same subject. Plan: L3 Task 11, D3, D7. L5 Task 8.
import { expect, test } from 'claude-code/testing'
import { backfillText, DOORS, isPersonPrompt, isTaskNoticeRow, NOT_TYPED, PERSON, readingOf } from '../core/infra/doors'
import { transcriptItems } from '../core/infra/replay'
import type { ReplayItem } from '../core/interfaces/events'
import type { Claim, Json } from '../core/interfaces/items'
import { scanContext } from '../core/lib/kind-context'
import { reasonSet } from '../core/lib/reasons'
import { artifactKind } from '../trackers/artifact/kind'
import { githubKind } from '../trackers/github/kind'
import { jiraKind } from '../trackers/jira/kind'
import { DELETE, PAGE_KEY, PAGE_URL, PUBLISH, REFUSED } from './fixtures/artifacts'
import type { ArtifactRecord, ItemRecord } from './fixtures/contracts'
import {
  commandRow,
  fakeItems,
  graphqlCalls,
  promptRow,
  replayRow,
  replayTool,
  res,
  responseRow,
  sleep,
  toolResultRow,
} from './fixtures/items'
import { MENTIONED } from './fixtures/reasons'

// ---------------------------------------------------------------- the doors

test('a prompt row with #5 and a Jira URL tracks both; the short ref is checked first', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('Look at issue #5 and https://acme.atlassian.net/browse/ISS-1'))
  expect(t.keys().sort()).toEqual(['gh:github.com/acme/web#5', 'jira:acme.atlassian.net/ISS-1'])
  expect(graphqlCalls(t.w.calls).length).toBe(1) // the open check of #5
  expect(t.persisted).toContain('items')
})

test('keyworded short refs are kept only when the item exists and is open', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('Check issue #5 and issue #404'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
})

test('a short ref is dropped when gh is missing', async () => {
  const t = fakeItems({ run: argv => (argv[0] === 'gh' ? { exitCode: 127, stdout: '', stderr: 'nope' } : undefined) })
  const items = await t.started()
  await items.capture(promptRow('Check issue #5 and https://github.com/cli/cli/pull/14640'))
  expect(t.keys()).toEqual(['gh:github.com/cli/cli#14640'])
})

test('rows of other makers are not captured: task notification, isMeta, subagent, coordinator', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('done: https://github.com/cli/cli/pull/14640 and #5', 'task-notification'))
  await items.capture(promptRow('see https://acme.atlassian.net/browse/ISS-2', 'composer', { isMeta: true }))
  await items.capture(promptRow('see https://acme.atlassian.net/browse/ISS-3', 'composer', { agentId: 'agent-7' }))
  await items.capture(promptRow('go and read #6', 'coordinator'))
  expect(t.keys()).toEqual([])
  expect(graphqlCalls(t.w.calls).length).toBe(0)
  expect([...PERSON].sort()).toEqual(['bridge', 'composer', 'sdk', 'unclassified'])
})

test('a row with no message and a door with no text rule capture nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/cli/cli/pull/14640', 'composer', { hasMessage: false }))
  await items.capture({
    door: 'note',
    origin: 'composer',
    isMeta: false,
    hasMessage: true,
    text: 'https://github.com/cli/cli/pull/14640',
  })
  await items.capture({ ...promptRow('https://github.com/cli/cli/pull/14640'), door: 'constructor' }) // a name, not a door
  expect(t.keys()).toEqual([])
  expect(Object.keys(DOORS).sort()).toEqual(['command', 'prompt', 'response', 'tool-result'])
})

test('command rows: our own engine output is skipped, a composer command is read from its args', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(commandRow('<command-name>/track</command-name>\n<command-args>#77</command-args>', 'engine'))
  await items.capture(
    commandRow('<local-command-stdout>Jira  ISS-77  #77 https://leak.example/x</local-command-stdout>', 'engine'),
  )
  await items.capture(
    commandRow(
      '<command-message>foo</command-message>\n<command-name>/foo https://outside.example/o</command-name>\n<command-args>issue #9</command-args>',
      'composer',
    ),
  )
  expect(t.keys()).toEqual(['gh:github.com/acme/web#9'])
})

test('a command with no args captures nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(commandRow('<command-name>/clear</command-name>', 'composer'))
  expect(t.keys()).toEqual([])
})

test('tool-result rows keep explicit GitHub and Jira URLs only, never bare #N or web links', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(toolResultRow('see https://example.com and #7, build #8 failed'))
  expect(t.keys()).toEqual([])
  await items.capture(toolResultRow('opened https://github.com/cli/cli/pull/14640 just now'))
  expect(t.keys()).toEqual(['gh:github.com/cli/cli#14640'])
})

test('a response row captures a web link and a PR URL', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(
    responseRow('See [the docs](https://code.claude.com/docs/en/plugins) and https://github.com/cli/cli/pull/14640.'),
  )
  expect(t.keys().sort()).toEqual(['gh:github.com/cli/cli#14640', 'web:https://code.claude.com/docs/en/plugins'])
})

test('a URL and a bare #N for the same item make one item', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('check issue #5'))
  await items.capture(responseRow('Fixed https://github.com/acme/web/issues/5 already.'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  expect(((t.list()[0] as ItemRecord).sources as string[]).sort()).toEqual(['prompt', 'response'])
})

test('a dismissed key is not captured again', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.dismissed.add('gh:github.com/cli/cli#14640')
  await items.capture(responseRow('https://github.com/cli/cli/pull/14640 and https://docs.example/a'))
  expect(t.keys()).toEqual(['web:https://docs.example/a'])
})

test('a prompt that names an existing .md file adds a mentioned file row', async () => {
  const t = fakeItems()
  t.w.files['/work/plan.md'] = '# plan'
  const items = await t.started()
  await items.capture(promptRow('please read plan.md'))
  expect(t.keys()).toEqual(['file:/work/plan.md'])
})

test('capture ignores an empty text and a row that reads as nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow(''))
  await items.capture(promptRow('see https://github.com/cli/cli/pull/14640', 'machine'))
  expect(readingOf(promptRow('x', 'composer'))).toEqual({ text: 'x', mode: 'full', source: 'prompt' })
  expect(t.keys()).toEqual([])
})

// ---------------------------------------------------------------- the accept of the kinds

test('a Jira URL of a foreign site in tool output is skipped', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(
    toolResultRow(
      "expect(root!.href).toBe('https://acme.atlassian.net/browse/ISS-101')\nsee https://vertice.atlassian.net/browse/ISS-2",
    ),
  )
  expect(t.keys()).toEqual(['jira:acme.atlassian.net/ISS-101'])
})

test('with no active Jira site every Jira ref of tool output is dropped', async () => {
  const t = fakeItems({
    run: argv => (argv[0] === 'acli' && argv[2] === 'auth' ? res('', 1, 'not logged in') : undefined),
  })
  const items = await t.started()
  await items.capture(
    toolResultRow('see https://acme.atlassian.net/browse/ISS-1 and https://github.com/cli/cli/pull/1'),
  )
  expect(t.keys()).toEqual(['gh:github.com/cli/cli#1'])
})

test('a Jira URL of tool output matches the active site in any case', async () => {
  const t = fakeItems() // acli answers `Site: acme.atlassian.net`
  const items = await t.started()
  await items.capture(toolResultRow('see https://ACME.atlassian.net/browse/ISS-1'))
  expect(t.keys()).toEqual(['jira:acme.atlassian.net/ISS-1'])
})

test('jira accept: the site of a claim is compared with the active site in any case', async () => {
  const t = fakeItems() // acli answers `Site: acme.atlassian.net`
  const items = await t.started()
  const ctx = { ...scanContext({ mode: 'urls-only', purpose: 'capture', source: 'tool' }), tools: items.tools('jira')! }
  const claim = (site: string): Claim => ({
    category: 'jira',
    key: `jira:${site.toLowerCase()}/ISS-1`,
    source: 'tool',
    reason: 'read',
    at: 1,
    fields: { site, issueKey: 'ISS-1', url: 'u', trackOnly: false },
  })
  const kept = await jiraKind.accept?.([claim('ACME.atlassian.net'), claim('other.atlassian.net')], ctx)
  expect(kept).toEqual([claim('ACME.atlassian.net')])
})

test('a kind whose accept throws loses its own claims; the other claims of the row still track', async () => {
  const t = fakeItems()
  t.w.files['/work/notes.md'] = '# notes'
  const items = await t.started()
  // The file kind asks the cwd for a `.md` mention; the GitHub URL needs no such call.
  t.w.ports.session.cwd = async () => {
    throw new Error('cwd gone')
  }
  await items.capture(promptRow('see notes.md and https://github.com/acme/web/pull/4'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#4'])
  expect(t.w.logs).toContain('items: accept failed in file: cwd gone')
})

test('jira accept: with no acli every claim stays; a Jira claim of a prompt is not filtered', async () => {
  const claim = (site: string): Claim => ({
    category: 'jira',
    key: `jira:${site}/A-1`,
    source: 'tool',
    reason: 'read',
    at: 1,
    fields: { site, issueKey: 'A-1', url: 'u', trackOnly: false },
  })
  const ctx = scanContext({ mode: 'urls-only', purpose: 'capture', source: 'tool' })
  expect(await jiraKind.accept?.([claim('a.atlassian.net')], ctx)).toEqual([claim('a.atlassian.net')])
  const typed = scanContext({ mode: 'full', purpose: 'capture', source: 'prompt' })
  expect(await jiraKind.accept?.([claim('a.atlassian.net')], typed)).toEqual([claim('a.atlassian.net')])
})

test('the open check of short refs: with no probe every same-repo ref goes, other refs stay', async () => {
  const short = (owner: string, repo: string): Claim => ({
    category: 'github',
    key: `gh:github.com/${owner}/${repo}#5`,
    source: 'prompt',
    reason: 'mentioned',
    at: 1,
    fields: { host: 'github.com', owner, repo, number: 5, type: 'unknown', short: true },
  })
  const same = short('acme', 'web')
  const other = short('cli', 'cli')
  const ctx = (repo: Json) => scanContext({ mode: 'full', purpose: 'capture', facts: { 'session.repo': repo } })
  const web = { host: 'github.com', owner: 'acme', repo: 'web' }
  expect(await githubKind.accept?.([same, other], ctx(web))).toEqual([other])
  expect(await githubKind.accept?.([same], ctx(null))).toEqual([same])
})

// ---------------------------------------------------------------- the tool calls and the tool rows

test('a delete of an unknown artifact adds no row', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall({ tool: 'Artifact', input: DELETE.input as Json, result: { result: DELETE.result } as Json })
  expect(t.keys()).toEqual([])
  expect(t.w.stateSets.items).toBeUndefined()
})

test('a tool-result row is urls-only', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(toolResultRow(`a page ${PAGE_URL} and https://docs.example/a and issue #5`))
  expect(t.keys()).toEqual([])
  expect(readingOf(toolResultRow('x'))).toEqual({ text: 'x', mode: 'urls-only', source: 'tool' })
})

// ---------------------------------------------------------------- replay

const use = (tool: string, result: unknown, isError = false, extra: Record<string, unknown> = {}) => ({
  tool_use_id: `t-${tool}`,
  tool,
  input: {},
  result,
  text: '',
  ...(isError ? { isError: true } : {}),
  ...extra,
})
const artifactUse = (shape: { input: unknown; result: unknown }, isError = false) =>
  use('Artifact', shape.result, isError, {
    input: shape.input,
    text: typeof shape.result === 'string' ? shape.result : 'Published.',
  })

// The tool results of Write, Edit and Read as the engine gives them (the kit world has the same four).
const writeCreated = (filePath: string) => ({
  type: 'create',
  filePath,
  content: '# x',
  structuredPatch: [],
  originalFile: null,
  userModified: false,
})
const editDone = (filePath: string) => ({
  filePath,
  oldString: 'a',
  newString: 'b',
  originalFile: 'a',
  structuredPatch: [],
  userModified: false,
  replaceAll: false,
})
const readDone = (filePath: string) => ({
  type: 'text',
  file: { filePath, content: '# x', numLines: 1, startLine: 1, totalLines: 1 },
})
// The answer of a second Read of a file that did not change (probe P1 of the #57 study, Claude Code 2.1.310).
const readUnchanged = (filePath: string) => ({ type: 'file_unchanged', file: { filePath } })

const batchOf = (messages: unknown[]) => transcriptItems(messages)

test('the backfill follows the rules of each role', async () => {
  const t = fakeItems()
  const items = await t.started()
  const messages = [
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
  ]
  await items.replay(batchOf(messages))
  expect(t.keys().sort()).toEqual([
    'gh:github.com/acme/web#5',
    'gh:github.com/acme/web#9',
    'gh:github.com/cli/cli#14640',
    'web:https://docs.example/a',
  ])
})

test('meta wrappers are skipped and an empty text gives nothing', () => {
  for (const tag of NOT_TYPED) expect(backfillText('user', `${tag}x`)).toBeNull()
  expect(backfillText('user', '')).toBeNull()
  expect(backfillText('assistant', '<system-reminder>kept for the model</system-reminder>')).not.toBeNull()
  expect(backfillText('user', '<command-name>/x</command-name><command-args>issue #3</command-args>')).toBe('issue #3')
  expect(readingOf(replayRow('prompt', '<task-notification>x').ev as never)).toBeNull()
  expect(readingOf({ ...replayRow('prompt', 'x'), door: 'note' } as never)).toBeNull()
})

test('a stored key wins over the transcript', async () => {
  const t = fakeItems()
  const items = await t.started()
  const kept = {
    key: 'web:https://docs.example/a',
    category: 'web',
    url: 'https://docs.example/a',
    label: 'Kept label',
    sources: ['response'],
    reasons: MENTIONED,
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  await items.slot.restore([kept] as unknown as Json, 'carry')
  await items.replay(batchOf([{ role: 'assistant', text: 'See [docs](https://docs.example/a)', toolUses: [] }]))
  const rec = t.list().find(r => r.key === kept.key)
  expect(rec?.label).toBe('Kept label')
  expect(rec?.seenCount).toBe(1)
})

test('a publish and a delete after the last flush win for an artifact; the tool text is no mention', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.replay(
    batchOf([
      { role: 'assistant', text: '', toolUses: [artifactUse(PUBLISH), artifactUse(REFUSED, true)] },
      { role: 'assistant', text: `Here it is: ${PAGE_URL}`, toolUses: [] },
      { role: 'assistant', text: '', toolUses: [artifactUse(DELETE)] },
    ]),
  )
  const rec = t.list().find(r => r.key === PAGE_KEY) as ArtifactRecord | undefined
  expect(rec?.deleted).toBeTruthy()
  expect(t.keys()).toEqual([PAGE_KEY])
})

test('a stored mention is repaired by the publish, and a known publish is not counted twice', async () => {
  const t = fakeItems()
  const items = await t.started()
  const mention: ArtifactRecord = {
    key: PAGE_KEY,
    category: 'artifact',
    url: PAGE_URL,
    label: PAGE_KEY,
    sources: ['response'],
    reasons: MENTIONED,
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  } as ArtifactRecord
  await items.slot.restore([mention] as unknown as Json, 'carry')
  const batch = batchOf([{ role: 'assistant', text: '', toolUses: [artifactUse(PUBLISH)] }])
  await items.replay(batch)
  expect((t.list()[0] as ArtifactRecord).label).toBe('Probe Page 29')
  const seen = (t.list()[0] as ItemRecord).seenCount
  await items.replay(batch)
  expect((t.list()[0] as ItemRecord).seenCount).toBe(seen)
})

test('a dismissed key never comes back', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.dismissed.add('web:https://docs.example/a')
  await items.replay(
    batchOf([
      { role: 'assistant', text: 'See [docs](https://docs.example/a) and [b](https://b.example/)', toolUses: [] },
    ]),
  )
  expect(t.keys()).toEqual(['web:https://b.example/'])
})

test('replay: a stored key wins, a later artifact publish wins, dismissed and foreign tool-only Jira never return, a lone Read adds a row', async () => {
  const t = fakeItems()
  t.w.files['/work/x.md'] = '# x'
  const items = await t.started()
  t.dismissed.add('web:https://d.example/')
  const base = { category: 'web', reasons: MENTIONED, firstSeen: 1, lastSeen: 1, seenCount: 1 }
  const stored = [
    { ...base, key: 'web:https://a.example/', url: 'https://a.example/', label: 'Old', sources: ['response'] },
    { ...base, key: PAGE_KEY, category: 'artifact', url: PAGE_URL, label: PAGE_KEY, sources: ['response'] },
  ]
  await items.slot.restore(stored as unknown as Json, 'carry')
  await items.replay([
    replayRow('prompt', '[New](https://a.example/) and [d](https://d.example/)'),
    replayTool('Artifact', PUBLISH.input as Json, artifactUse(PUBLISH) as Json),
    replayTool('Bash', {}, { tool: 'Bash', text: 'https://other.atlassian.net/browse/ISS-9' } as Json),
    replayTool('Read', {}, use('Read', readDone('/work/x.md')) as Json),
  ])
  expect(t.list().find(r => r.key === 'web:https://a.example/')?.label).toBe('Old') // the stored key wins
  const page = t.list().find(r => r.key === PAGE_KEY) as ArtifactRecord
  expect(page.reasons.all).toContain('published') // the transcript knew the publish
  // No d.example, no ISS-9. A lone Read of x.md adds its row (issue #57).
  expect(t.keys().sort()).toEqual([PAGE_KEY, 'file:/work/x.md', 'web:https://a.example/'].sort())
})

// A replay runs inside a session load or switch, so it must not wait for a CLI (parent: `ensureRepo` was not awaited and
// the repo was read as far as it was known). The git remote is read at once, so a github.com remote is known by then.
const raceReplay = async (items: { replay(b: ReplayItem[]): Promise<void> }, batch: ReplayItem[], ms = 300) =>
  Promise.race([items.replay(batch).then(() => 'done'), sleep(ms).then(() => 'waited')])

test('replay does not wait for a slow gh repo view; the lookup runs on and a later prepare waits for it', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = fakeItems({
    remote: null, // no git remote: the repo comes from `gh repo view`
    run: async argv => {
      if (argv[0] !== 'gh' || argv[1] !== 'repo') return undefined
      await gate
      return res('{"nameWithOwner":"acme/web"}')
    },
  })
  const items = await t.started()
  try {
    expect(await raceReplay(items, [replayRow('prompt', 'see https://example.com/a and issue #5')])).toBe('done')
    expect(t.keys()).toEqual(['web:https://example.com/a']) // #5 needs the repo, which is not known yet
    expect(t.facts.read('session.repo')).toBeUndefined()
  } finally {
    release()
  }
  await items.prepare()
  expect(t.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
})

test('replay does not wait for the gh check of a remote host that is not github.com', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = fakeItems({
    remote: { host: 'ghe.corp', owner: 'acme', repo: 'web' },
    run: async argv => {
      if (argv[0] !== 'gh' || argv[1] !== 'auth') return undefined
      await gate
      return res('Logged in')
    },
  })
  const items = await t.started()
  try {
    expect(await raceReplay(items, [replayRow('prompt', 'see https://ghe.corp/acme/web/pull/7')])).toBe('done')
    expect(t.keys()).toEqual(['web:https://ghe.corp/acme/web/pull/7']) // github.hosts is not known yet
  } finally {
    release()
  }
  await items.prepare()
  expect(t.facts.read('github.hosts')).toEqual(['ghe.corp'])
})

test('replay waits for the git remote, so a keyworded #N of the transcript counts, and calls no gh repo view', async () => {
  const t = fakeItems()
  t.w.ports.session.repo = async () => {
    await sleep(20)
    return { host: 'github.com', owner: 'acme', repo: 'web' }
  }
  const items = await t.started()
  await items.replay([replayRow('prompt', 'please look at issue #5')])
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  expect(t.w.calls.filter(c => c[0] === 'gh' && c[1] === 'repo')).toEqual([])
})

test('a git remote that fails to read is the answer: no repo, no gh call', async () => {
  const t = fakeItems()
  t.w.ports.session.repo = async () => {
    throw new Error('no engine')
  }
  const items = await t.started()
  await items.replay([replayRow('prompt', 'see https://example.com/a and issue #5')])
  expect(t.keys()).toEqual(['web:https://example.com/a'])
  expect(t.facts.read('session.repo')).toBeUndefined()
  expect(t.facts.read('github.hosts')).toEqual([])
  expect(t.w.calls.filter(c => c[0] === 'gh' && c[1] === 'repo')).toEqual([])
})

test('an empty batch changes nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.prepare() // finding the repo may re-key the list once
  const writes = t.w.stateSets.items
  await items.replay([])
  expect(t.w.stateSets.items).toBe(writes)
})

test('file rows come from Write, Edit and Read results, of any type, and from mentions', async () => {
  const t = fakeItems()
  t.w.files['/work/README.md'] = '/work/README.md'
  const items = await t.started()
  await items.replay(
    batchOf([
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
          use('Write', writeCreated('/work/src/a.ts')),
          use('Read', { type: 'image', file: { base64: '…', type: 'image/png' } }, false, {
            input: { file_path: '/work/img.png' },
          }),
          use('NotebookEdit', { notebook_path: '/work/nb.ipynb', error: '', edit_mode: 'replace' }),
        ],
      },
    ]),
  )
  const files = t.list().filter(r => r.category === 'file') as unknown as {
    key: string
    activity?: unknown
    views: number
  }[]
  expect(files.map(f => f.key).sort()).toEqual([
    'file:/work/README.md',
    'file:/work/docs/old.md', // a Read alone adds a row (issue #57)
    'file:/work/docs/plan.md',
    'file:/work/img.png', // the path of an image Read is its input
    'file:/work/nb.ipynb',
    'file:/work/src/a.ts',
  ])
  expect(files.find(f => f.key === 'file:/work/docs/plan.md')?.views).toBe(1)
})

test('a replayed Bash use counts the files of its bashEditDiff, and one with none adds nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  // The shape is taken from the live tool result. A stored transcript may not hold `bashEditDiff`: that is a live check (L4 of the
  // #57 study) that this test does not make.
  const diff = {
    files: [{ filePath: '/work/out.txt', hunks: [], created: true }],
    moreFiles: 0,
    changedFiles: ['/work/out.txt'],
  }
  await items.replay(
    batchOf([
      {
        role: 'assistant',
        text: '',
        toolUses: [
          use('Bash', { stdout: '', stderr: '', bashEditDiff: diff }, false, {
            input: { command: 'echo hi > out.txt' },
          }),
          use('Bash', { stdout: 'x', stderr: '' }, false, { input: { command: 'ls' } }),
        ],
      },
    ]),
  )
  expect(t.keys()).toEqual(['file:/work/out.txt'])
})

test('a replayed Read of an unchanged file counts a view, as a Read of text does (issue #245)', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.replay(
    batchOf([
      {
        role: 'assistant',
        text: '',
        toolUses: [
          use('Read', readUnchanged('/work/docs/lone.md')), // a Read alone adds a row (issue #57)
          use('Write', writeCreated('/work/docs/plan.md')),
          use('Read', readDone('/work/docs/plan.md')),
          use('Read', readUnchanged('/work/docs/plan.md')),
        ],
      },
    ]),
  )
  const files = t.list().filter(r => r.category === 'file') as unknown as { key: string; views: number }[]
  expect(files.map(f => [f.key, f.views])).toEqual([
    ['file:/work/docs/lone.md', 1],
    ['file:/work/docs/plan.md', 2],
  ])
})

test('a replayed batch built by hand reaches the same rules', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.replay([
    replayRow('prompt', 'see https://docs.example/p'),
    replayTool('Bash', {}, { tool: 'Bash', text: 'opened https://github.com/cli/cli/pull/14640' } as Json),
  ])
  expect(t.keys().sort()).toEqual(['gh:github.com/cli/cli#14640', 'web:https://docs.example/p'])
})

test('artifact replayWins: a publish over a mention, a delete over a live row, nothing else', () => {
  const rec = (why: 'published' | 'mentioned', deleted?: true) =>
    ({
      key: PAGE_KEY,
      category: 'artifact',
      url: PAGE_URL,
      label: 'x',
      sources: [why === 'published' ? 'tool' : 'response'],
      reasons: reasonSet(why),
      deleted,
    }) as unknown as ArtifactRecord
  const wins = artifactKind.replayWins!
  expect(wins(rec('published'), rec('mentioned'))).toBe(true)
  expect(wins(rec('mentioned', true), rec('mentioned'))).toBe(true)
  expect(wins(rec('published'), rec('published'))).toBe(false)
  expect(wins(rec('mentioned'), rec('published'))).toBe(false)
  expect(wins(rec('published', true), rec('published', true))).toBe(false)
})

// ---------------------------------------------------------------- the rows the turn ledger reads (issue #69)

test('isPersonPrompt: the person typed it on the prompt door, in the main loop, with a message; nothing else is', () => {
  for (const origin of PERSON) expect(isPersonPrompt(promptRow('hi', origin))).toBe(true)
  expect(isPersonPrompt(promptRow('hi', 'task-notification'))).toBe(false)
  expect(isPersonPrompt(promptRow('hi', 'coordinator'))).toBe(false)
  expect(isPersonPrompt(promptRow('hi', 'composer', { isMeta: true }))).toBe(false)
  expect(isPersonPrompt(promptRow('hi', 'composer', { agentId: 'a1' }))).toBe(false)
  expect(isPersonPrompt(promptRow('hi', 'composer', { hasMessage: false }))).toBe(false)
  expect(isPersonPrompt(commandRow('/clear', 'composer'))).toBe(false)
})

test('isTaskNoticeRow: a prompt row of origin task-notification, and no other row', () => {
  expect(isTaskNoticeRow(promptRow('<task-notification>', 'task-notification'))).toBe(true)
  expect(isTaskNoticeRow(promptRow('hi', 'composer'))).toBe(false)
  expect(isTaskNoticeRow(responseRow('<task-notification>'))).toBe(false)
})

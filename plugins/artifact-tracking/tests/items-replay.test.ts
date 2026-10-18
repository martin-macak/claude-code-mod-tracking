// Items from a replayed transcript on fakePorts: the backfill rules per role, what a stored key keeps, what only the
// transcript may know of an artifact, and the dismissed keys. Each case mirrors the kit test of the same subject.
// Plan: L3 Task 11, D7.
import { expect, test } from 'claude-code/testing'
import { transcriptItems } from '../core/infra/replay'
import type { Json } from '../core/interfaces/items'
import type { ArtifactRecord, ItemRecord } from '../hooks/contracts'
import { backfillText, NOT_TYPED, onlyNew } from '../hooks/items/replay'
import { DELETE, PAGE_KEY, PAGE_URL, PUBLISH, REFUSED } from './fixtures/artifacts'
import { itemsWorld, replayRow, replayTool } from './fixtures/items'

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

// The tool results of Write, Edit and Read as the engine gives them (the kit world has the same three).
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

const batchOf = (messages: unknown[]) => transcriptItems(messages)

test('the backfill follows the rules of each role', async () => {
  const t = itemsWorld()
  const rt = await t.started()
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
  await rt.replay(batchOf(messages))
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
})

test('a stored key wins over the transcript', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  const kept = {
    key: 'web:https://docs.example/a',
    category: 'web',
    url: 'https://docs.example/a',
    label: 'Kept label',
    sources: ['response'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  await rt.slot.restore([kept] as unknown as Json, 'carry')
  await rt.replay(batchOf([{ role: 'assistant', text: 'See [docs](https://docs.example/a)', toolUses: [] }]))
  const rec = t.list().find(r => r.key === kept.key)
  expect(rec?.label).toBe('Kept label')
  expect(rec?.seenCount).toBe(1)
})

test('a publish and a delete after the last flush win for an artifact; the tool text is no mention', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.replay(
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
  const t = itemsWorld()
  const rt = await t.started()
  const mention: ArtifactRecord = {
    key: PAGE_KEY,
    category: 'artifact',
    url: PAGE_URL,
    label: PAGE_KEY,
    sources: ['response'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  } as ArtifactRecord
  await rt.slot.restore([mention] as unknown as Json, 'carry')
  const batch = batchOf([{ role: 'assistant', text: '', toolUses: [artifactUse(PUBLISH)] }])
  await rt.replay(batch)
  expect((t.list()[0] as ArtifactRecord).label).toBe('Probe Page 29')
  const seen = (t.list()[0] as ItemRecord).seenCount
  await rt.replay(batch)
  expect((t.list()[0] as ItemRecord).seenCount).toBe(seen)
})

test('a dismissed key never comes back', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  t.dismissed.add('web:https://docs.example/a')
  await rt.replay(
    batchOf([
      { role: 'assistant', text: 'See [docs](https://docs.example/a) and [b](https://b.example/)', toolUses: [] },
    ]),
  )
  expect(t.keys()).toEqual(['web:https://b.example/'])
})

test('an empty batch changes nothing', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.ensureRepo() // finding the repo may re-key the list once
  const writes = t.w.stateSets.items
  await rt.replay([])
  expect(t.w.stateSets.items).toBe(writes)
})

test('file rows come from Write, Edit and Read results and from mentions', async () => {
  const t = itemsWorld()
  t.w.files['/work/README.md'] = '/work/README.md'
  const rt = await t.started()
  await rt.replay(
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
        ],
      },
    ]),
  )
  const files = t.list().filter(r => r.category === 'file') as unknown as {
    key: string
    activity?: unknown
    views: number
  }[]
  expect(files.map(f => f.key).sort()).toEqual(['file:/work/README.md', 'file:/work/docs/plan.md'])
  expect(files.find(f => f.key === 'file:/work/docs/plan.md')?.views).toBe(1)
})

test('a replayed batch built by hand reaches the same rules', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.replay([
    replayRow('prompt', 'see https://docs.example/p'),
    replayTool('Bash', {}, { tool: 'Bash', text: 'opened https://github.com/cli/cli/pull/14640' } as Json),
  ])
  expect(t.keys().sort()).toEqual(['gh:github.com/cli/cli#14640', 'web:https://docs.example/p'])
})

test('onlyNew keeps unknown keys, and a known key only when the transcript knows more of an artifact', () => {
  const w = (key: string): ItemRecord =>
    ({ key, category: 'web', url: key, label: key, sources: [], firstSeen: 1, lastSeen: 1, seenCount: 1 }) as ItemRecord
  expect(onlyNew([w('a')], [w('a'), w('b')]).map(r => r.key)).toEqual(['b'])
})

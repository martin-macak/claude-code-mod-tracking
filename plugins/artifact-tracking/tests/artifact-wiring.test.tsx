// Kit tests of the artifact wiring (issue #29): mentions, the Artifact tool hook, clear, store, restore, backfill.
// The tool results are the shapes the design study observed (fixtures/artifacts.ts). The kit drops `agentId`, so a
// subagent's publish is covered by artifact-tool.test.ts: the hook does not read it.
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'
import { addReason, reasonSet } from '../core/lib/reasons'
import {
  ASSET,
  DELETE,
  DELETE_REJECTED,
  DOC_URL,
  FROM_TYPE,
  PAGE_CODE_URL,
  PAGE_ID,
  PAGE_KEY,
  PAGE_URL,
  PAGE_UUID,
  PUBLISH,
  READ,
  REFUSED,
  REPUBLISH,
} from './fixtures/artifacts'
import type { ArtifactRecord, ItemRecord } from './fixtures/contracts'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { mountPane, select } from './fixtures/pane'
import { MENTIONED, reasonsOfSources } from './fixtures/reasons'
import { clearSession, prompt, quiet, response, SESSION, START, toolResult, track, world } from './fixtures/world'

type World = ReturnType<typeof world>
type Shape = { input: Record<string, unknown>; result: unknown }

let n = 0
/** One Artifact tool call. The fake engine answers `shape.result`, as an error when `isError`. */
async function call($: Engine, w: World, shape: Shape, isError = false): Promise<void> {
  w.fake.toolReplies.Artifact = isError ? { isError: true, result: shape.result } : { result: shape.result }
  await $.tool.call({ tool: 'Artifact', ...shape.input, tool_use_id: `toolu_art_${++n}` } as never)
}

async function settle(w: World): Promise<void> {
  await w.clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(w.calls)
}

const text = async ($: Engine): Promise<string> => (await track($)).text ?? ''
const ROW = `Probe Page 29  ${PAGE_ID}  published`

/** A stored artifact row, as a flush writes it. */
const stored = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  key: PAGE_KEY,
  category: 'artifact',
  url: PAGE_URL,
  label: 'Probe Page 29',
  sources: ['tool'],
  reasons: over.deleted ? addReason(reasonSet('published'), 'deleted') : reasonSet('published'),
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
  ...over,
})
const seed = (items: ItemRecord[]) => ({ 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items } })
/** A transcript tool use of the Artifact tool. */
const use = (shape: Shape, isError = false) => ({
  tool_use_id: `toolu_t_${++n}`,
  tool: 'Artifact',
  input: shape.input,
  result: shape.result,
  text: typeof shape.result === 'string' ? shape.result : 'Published.',
  ...(isError ? { isError: true } : {}),
})

// ---------------------------------------------------------------- mentions

test('response row: an artifact URL is an artifact, mentioned, and not a web link', async ($, on) => {
  const w = world(on)
  await $.session.append(response(`See ${PAGE_URL}`))
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${PAGE_ID}  mentioned`)
})

test('prompt row: a Markdown label names the artifact', async ($, on) => {
  const w = world(on)
  await $.session.append(prompt(`Look at [Design notes](${PAGE_CODE_URL})`))
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  Design notes  ${PAGE_UUID}  mentioned`)
})

test('tool-result row: an artifact URL in tool output is not a mention', async ($, on) => {
  const w = world(on)
  await $.session.append(toolResult(`Published at ${PAGE_URL}`))
  await settle(w)
  expect(await text($)).toBe('No tracked items yet.')
})

// ---------------------------------------------------------------- the Artifact tool

test('publish: the observed result gives the page title, not the file name', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH)
  await settle(w)
  const out = await text($)
  expect(out).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
  expect(out).not.toContain('p29.html')
})

test('publish: an explicit publish action counts like an omitted one', async ($, on) => {
  const w = world(on)
  await call($, w, { ...PUBLISH, input: { ...PUBLISH.input, action: 'publish' } })
  await settle(w)
  expect(await text($)).toContain(ROW)
})

test('publish: without a title the row takes the file name', async ($, on) => {
  const w = world(on)
  const { title: _, ...untitled } = PUBLISH.result
  await call($, w, { input: PUBLISH.input, result: untitled })
  await settle(w)
  expect(await text($)).toContain(`p29.html  ${PAGE_ID}  published`)
})

test('publish: errors, refusals, string results and other actions add nothing', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH, true) // isError with a full publish result
  await call($, w, REFUSED, true)
  await call($, w, { input: REFUSED.input, result: REFUSED.result }) // a string that quotes the URL, no isError
  await call($, w, READ)
  await call($, w, { input: PUBLISH.input, result: { error: 'refused' } }) // no page URL
  await settle(w)
  expect(await text($)).toBe('No tracked items yet.')
})

test('publish then a mention of the other URL form: one row, published, with the title', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH)
  await $.session.append(response(`Link again: [the page](${PAGE_CODE_URL})`))
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
})

test('a mention, then a publish: the row becomes published and takes the title', async ($, on) => {
  const w = world(on)
  await $.session.append(response(`Draft: ${PAGE_CODE_URL}`))
  await settle(w)
  await call($, w, PUBLISH)
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
})

test('a republish, an untitled update and an asset upload keep the title', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH)
  await call($, w, REPUBLISH)
  await call($, w, {
    input: { url: PAGE_URL, file_path: '/tmp/x/report.html' },
    result: { url: PAGE_URL, path: '/tmp/x/report.html' },
  })
  await call($, w, ASSET)
  await settle(w)
  const out = await text($)
  expect(out).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
  expect(out).not.toContain('report.html')
  expect(out).not.toContain('p29.txt')
})

test('an Artifact created from a type is published with its title', async ($, on) => {
  const w = world(on)
  await call($, w, FROM_TYPE)
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  Probe Doc 29  ${DOC_URL.split('/').pop()}  published`)
})

// ---------------------------------------------------------------- delete

test('delete: a successful delete marks the row; a later mention keeps the mark', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH)
  await call($, w, DELETE)
  await $.session.append(response(`It was ${PAGE_URL}`))
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}  deleted`)
})

test('delete: a rejected delete changes nothing; an unknown artifact gets no row', async ($, on) => {
  const w = world(on)
  await call($, w, DELETE)
  await settle(w)
  expect(await text($)).toBe('No tracked items yet.')
  await call($, w, PUBLISH)
  await call($, w, DELETE_REJECTED, true)
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
})

// ---------------------------------------------------------------- dismiss, clear, store

test('pane: a dismissed artifact stays out after a new publish', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH)
  await settle(w)
  await track($)
  const ui = await mountPane($)
  await select($, ui, 'Probe Page 29')
  await ui.press({ key: 'dismiss' })
  await quiet(w.calls)
  await call($, w, REPUBLISH)
  await settle(w)
  expect(await text($)).toBe('No tracked items yet.')
  await ui.unmount()
})

test('/track clear removes the artifact and its stored copy', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH)
  await w.clock.advance(LIMITS.flushMs + 10)
  await quiet(w.calls)
  expect(w.store.has('v2:s:' + SESSION)).toBe(true)
  expect((await track($, 'clear')).text).toBe('Tracking list cleared.')
  expect(await text($)).toBe('No tracked items yet.')
  expect(w.store.has('v2:s:' + SESSION)).toBe(false)
})

test('the stored copy holds the artifact with the reasons published and deleted, its title and the delete mark', async ($, on) => {
  const w = world(on)
  await call($, w, PUBLISH)
  await call($, w, DELETE)
  await w.clock.advance(LIMITS.flushMs + 10)
  await quiet(w.calls)
  const copy = w.store.get('v2:s:' + SESSION) as { items: ItemRecord[] }
  expect(copy.items).toEqual([
    { ...stored({ deleted: true }), firstSeen: expect.anything(), lastSeen: expect.anything() },
  ])
})

// ---------------------------------------------------------------- restore, backfill, carry-over

test('session.start restores a stored artifact with its origin, title and delete mark', async ($, on) => {
  world(on, { seed: seed([stored({ deleted: true })]) })
  await $.session.start(START)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}  deleted`)
})

test('session.start backfills a publish and a delete from the transcript; tool text is no mention', async ($, on) => {
  world(on, {
    messages: [
      { role: 'assistant', text: '', toolUses: [use(PUBLISH), use(REFUSED, true)] },
      { role: 'assistant', text: `Here it is: ${PAGE_URL}`, toolUses: [] },
      { role: 'assistant', text: '', toolUses: [use(DELETE)] },
    ],
  })
  await $.session.start(START)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}  deleted`)
})

test('session.start: a stale stored mention is repaired by the publish in the transcript', async ($, on) => {
  const mention = stored({ url: PAGE_CODE_URL, label: PAGE_UUID, sources: ['response'], reasons: MENTIONED })
  world(on, { seed: seed([mention]), messages: [{ role: 'assistant', text: '', toolUses: [use(PUBLISH)] }] })
  await $.session.start(START)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
})

test('session.start: a stored copy that already knows the publish is not counted twice', async ($, on) => {
  const w = world(on, { seed: seed([stored()]), messages: [{ role: 'assistant', text: '', toolUses: [use(PUBLISH)] }] })
  await $.session.start(START)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
  await w.clock.advance(LIMITS.flushMs + 10)
  await quiet(w.calls)
  const copy = w.store.get('v2:s:' + SESSION) as { items: ItemRecord[] } | undefined
  expect(copy?.items[0]?.seenCount ?? 1).toBe(1)
})

test('/clear carry-over keeps an artifact with its origin and title', async ($, on) => {
  const w = world(on, { isolateState: true })
  await call($, w, PUBLISH)
  await $.session.append(response(`See ${PAGE_CODE_URL}`))
  await clearSession($, w, 'sess-2', 'clear') // what /clear does
  await settle(w)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${ROW}`)
})

// ---------------------------------------------------------------- rows an older version stored as web links (R13)

const oldWeb = (url: string, label: string): ItemRecord => ({
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

test('session.start moves a stored web row of an artifact URL to Artifacts, one row with the transcript', async ($, on) => {
  world(on, {
    seed: seed([oldWeb(PAGE_URL, `claude.ai/artifact/${PAGE_ID}`), oldWeb('https://x.example/', 'X')]),
    messages: [{ role: 'assistant', text: `Again ${PAGE_CODE_URL}`, toolUses: [] }],
  })
  await $.session.start(START)
  expect(await text($)).toBe(`Artifacts  1 artifacts\n  ${PAGE_ID}  mentioned\n\nWeb links  1 links\n  X  x.example`)
})

test('/clear carry-over moves an old web row of an artifact URL to Artifacts', async ($, on) => {
  const w = world(on, { seed: seed([oldWeb(PAGE_URL, 'Design notes')]) })
  await $.session.append(prompt('first https://example.org/a')) // learns the id; no session.start, so nothing is restored
  await clearSession($, w, 'sess-2', 'clear')
  await $.session.append(response(`and ${PAGE_URL}`))
  await settle(w)
  const out = await text($)
  expect(out).toContain(`Artifacts  1 artifacts\n  Design notes  ${PAGE_ID}  mentioned`)
  expect(out).not.toContain('claude.ai/artifact')
})

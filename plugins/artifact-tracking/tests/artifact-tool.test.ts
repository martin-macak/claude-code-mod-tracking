// The Artifact tool call as an event: every row of the table in the design study on #29 (§3). Pure.
// The kit's `$.tool.call` drops `agentId`, so the subagent case is tested here: the hook never reads it (G10).
import { expect, test } from 'claude-code/testing'
import { artifactEvent } from '../trackers/artifact/artifact-tool'
import { artifactUuid } from '../trackers/artifact/artifact-url'
import {
  ASSET,
  DELETE,
  DELETE_REJECTED,
  DOC_URL,
  FROM_TYPE,
  MISSING_FILE,
  PAGE_ID,
  PAGE_KEY,
  PAGE_URL,
  PAGE_UUID,
  PAIRS,
  PUBLISH,
  READ,
  REFUSED,
  REPUBLISH,
} from './fixtures/artifacts'

const ok = (x: { input: unknown; result: unknown }) => artifactEvent(x.input, { result: x.result })
const failed = (x: { input: unknown; result: unknown }) => artifactEvent(x.input, { result: x.result, isError: true })
const page = { category: 'artifact', uuid: PAGE_UUID, url: PAGE_URL } as const

test('a publish: the page with its title', () => {
  expect(ok(PUBLISH)).toEqual({ kind: 'published', ref: { ...page, label: 'Probe Page 29', titled: true } })
})

test('a republish to the same URL is a publish', () => {
  expect(ok(REPUBLISH)).toEqual({ kind: 'published', ref: { ...page, label: 'Probe Page 29', titled: true } })
})

test("a subagent's publish has the same shape (I:56); agentId does not matter", () => {
  const [id, uuid] = PAIRS[1]
  const url = `https://claude.ai/artifact/${id}`
  const input = { action: 'publish', file_path: '/tmp/work/p29b.html', icon: 'code', agentId: 'ab37e6187d25dd36e' }
  const result = { url, path: '/tmp/work/p29b.html', artifact_id: uuid, title: 'Probe Sub 29', updated: false }
  expect(artifactEvent(input, { result })).toEqual({
    kind: 'published',
    ref: { category: 'artifact', uuid, url, label: 'Probe Sub 29', titled: true },
  })
})

test('an asset upload is a publish without a title', () => {
  expect(ok(ASSET)).toEqual({ kind: 'published', ref: { ...page, label: PAGE_ID } })
})

test('a multi-file asset upload and an asset copy are publishes without a title', () => {
  const uploads = { written: { url: PAGE_URL }, asset_uploads: { url: PAGE_URL, results: [] } }
  expect(artifactEvent({ ...ASSET.input, file_paths: ['/tmp/a.png'] }, { result: uploads })).toEqual({
    kind: 'published',
    ref: { ...page, label: PAGE_ID },
  })
  const copy = { asset_copy: { url: PAGE_URL, from_url: DOC_URL, assets: [] } }
  expect(artifactEvent({ url: PAGE_URL, from_url: DOC_URL, asset: true }, { result: copy })?.kind).toBe('published')
})

test('an Artifact created from a type: its title, no artifact_id needed', () => {
  expect(ok(FROM_TYPE)).toEqual({
    kind: 'published',
    ref: {
      category: 'artifact',
      uuid: artifactUuid('D3zR4h4m4W1diV3brT2Mbo'),
      url: DOC_URL,
      label: 'Probe Doc 29',
      titled: true,
    },
  })
})

test('the title: result.title, then the title input, then the file name, then the id', () => {
  const { title: _, ...untitled } = PUBLISH.result
  expect(artifactEvent({ ...PUBLISH.input, title: 'Input title' }, { result: untitled })).toEqual({
    kind: 'published',
    ref: { ...page, label: 'Input title', titled: true },
  })
  expect(artifactEvent(PUBLISH.input, { result: untitled })).toEqual({
    kind: 'published',
    ref: { ...page, label: 'p29.html' },
  })
  expect(artifactEvent({}, { result: untitled })).toEqual({ kind: 'published', ref: { ...page, label: PAGE_ID } })
  expect(artifactEvent(PUBLISH.input, { result: { ...PUBLISH.result, title: ` A\n${'b'.repeat(80)} ` } })).toEqual({
    kind: 'published',
    ref: { ...page, label: `A ${'b'.repeat(57)}…`, titled: true },
  })
})

test('a delete marks the artifact; already gone counts as deleted', () => {
  expect(ok(DELETE)).toEqual({ kind: 'deleted', key: PAGE_KEY })
  const gone = { artifact_delete: { url: PAGE_URL, deleted: true, already_gone: true } }
  expect(artifactEvent(DELETE.input, { result: gone })).toEqual({ kind: 'deleted', key: PAGE_KEY })
})

test('errors, refusals, rejections and plugin denials give nothing', () => {
  expect(failed(MISSING_FILE)).toBeNull()
  expect(failed(REFUSED)).toBeNull()
  expect(failed(DELETE_REJECTED)).toBeNull()
  expect(artifactEvent(PUBLISH.input, { deny: 'blocked by a plugin' })).toBeNull()
  expect(failed(PUBLISH)).toBeNull() // isError wins even over a publish-shaped result
})

test('a result that is not an object gives nothing, even without isError', () => {
  expect(artifactEvent(REFUSED.input, { result: REFUSED.result })).toBeNull()
  expect(artifactEvent(PUBLISH.input, { result: [PUBLISH.result] })).toBeNull()
  expect(artifactEvent(PUBLISH.input, null)).toBeNull()
  expect(artifactEvent(PUBLISH.input, 'ran')).toBeNull()
})

test('other actions and other shapes give nothing', () => {
  expect(ok(READ)).toBeNull()
  for (const action of ['list', 'open', 'pin', 'unpin', 'quickstart'])
    expect(artifactEvent({ action, url: PAGE_URL }, { result: PUBLISH.result })).toBeNull()
  expect(artifactEvent({}, { result: { opened: true, url: PAGE_URL, artifact_id: PAGE_UUID } })).toBeNull()
  expect(artifactEvent({}, { result: { written: { url: PAGE_URL } } })).toBeNull() // a write_db-like result
  expect(artifactEvent({}, { result: { url: PAGE_URL } })).toBeNull() // no artifact_id, no path
  expect(artifactEvent({ asset: true }, { result: PUBLISH.result })).toBeNull() // an asset call needs an asset result
  expect(
    artifactEvent({ action: 'delete', url: PAGE_URL }, { result: { asset_delete: { id: 'x', deleted: true } } }),
  ).toBeNull()
  expect(artifactEvent({}, { result: { ...PUBLISH.result, url: 'https://claude.ai/artifact/new' } })).toBeNull()
})

// Artifact URLs: base58 ids, UUIDs, the two URL forms and their key (issue #29). Pure.
import { expect, test } from 'claude-code/testing'
import { artifactUuid, clipLabel, parseArtifactUrl } from '../trackers/artifact/artifact-url'
import { PAIRS } from './fixtures/artifacts'

test('artifactUuid: the observed base58 ids decode to their UUIDs', () => {
  for (const [id, uuid] of PAIRS) expect(artifactUuid(id)).toBe(uuid)
})

test('artifactUuid: a UUID comes back in lower case', () => {
  expect(artifactUuid('5783ECE9-DA46-4561-BDBE-8934F28BDEDF')).toBe('5783ece9-da46-4561-bdbe-8934f28bdedf')
})

test('artifactUuid: bad ids are null', () => {
  expect(artifactUuid('new')).toBeNull() // too short to be a 128-bit id
  expect(artifactUuid('foo-bar_0OIl')).toBeNull()
  for (const c of ['0', 'O', 'I', 'l']) expect(artifactUuid('BonxpzeoKWbU2yQqP24wV' + c)).toBeNull()
  expect(artifactUuid('BonxpzeoKWbU2yQqP24wVgx')).toBeNull() // 23 chars
  expect(artifactUuid('zzzzzzzzzzzzzzzzzzzzzz')).toBeNull() // 2^128 or more
  expect(artifactUuid('5783ece9-da46-4561-bdbe')).toBeNull()
})

test('parseArtifactUrl: both URL forms of one artifact give one UUID, and keep the URL as seen', () => {
  for (const [id, uuid] of PAIRS) {
    expect(parseArtifactUrl(`https://claude.ai/artifact/${id}`)).toEqual({
      category: 'artifact',
      uuid,
      url: `https://claude.ai/artifact/${id}`,
      label: id,
    })
    expect(parseArtifactUrl(`https://claude.ai/code/artifact/${uuid}`)).toEqual({
      category: 'artifact',
      uuid,
      url: `https://claude.ai/code/artifact/${uuid}`,
      label: uuid,
    })
  }
})

test('parseArtifactUrl: host case, www, http, query, fragment and one trailing slash', () => {
  const [id, uuid] = PAIRS[0]
  for (const url of [
    `https://CLAUDE.AI/artifact/${id}/`,
    `https://www.claude.ai/artifact/${id}?x=1#y`,
    `http://claude.ai/artifact/${id}`,
  ])
    expect(parseArtifactUrl(url)).toEqual({
      category: 'artifact',
      uuid,
      url: `https://claude.ai/artifact/${id}`,
      label: id,
    })
})

test('parseArtifactUrl: other paths, hosts and bad ids are not artifacts', () => {
  const [id] = PAIRS[0]
  expect(parseArtifactUrl(`https://claude.ai/artifact/${id}/edit`)).toBeNull()
  expect(parseArtifactUrl(`https://claude.ai/artifact/${id}//`)).toBeNull()
  expect(parseArtifactUrl('https://claude.ai/artifact/new')).toBeNull()
  expect(parseArtifactUrl('https://claude.ai/artifact/not-valid-0OIl')).toBeNull()
  expect(parseArtifactUrl(`https://claude.ai/artifacts/${id}`)).toBeNull()
  expect(parseArtifactUrl(`https://example.com/artifact/${id}`)).toBeNull()
  expect(parseArtifactUrl(`ftp://claude.ai/artifact/${id}`)).toBeNull()
  expect(parseArtifactUrl('not a url')).toBeNull()
})

test('parseArtifactUrl: a Markdown label becomes the label, cut to 60 chars', () => {
  const [id] = PAIRS[0]
  const url = `https://claude.ai/artifact/${id}`
  expect(parseArtifactUrl(url, 'Design notes')?.label).toBe('Design notes')
  expect(parseArtifactUrl(url, url)?.label).toBe(id)
  expect(parseArtifactUrl(url, '  ')?.label).toBe(id)
  expect(parseArtifactUrl(url, 'x'.repeat(100))?.label).toBe('x'.repeat(59) + '…')
})

test('clipLabel: control characters and runs of space become one space; long text is cut', () => {
  expect(clipLabel(' Probe\tPage\n\n29 ')).toBe('Probe Page 29')
  expect(clipLabel('a'.repeat(60))).toBe('a'.repeat(60))
  expect(clipLabel('a'.repeat(61))).toBe('a'.repeat(59) + '…')
  expect(clipLabel('\u0000\u001b')).toBe('')
})

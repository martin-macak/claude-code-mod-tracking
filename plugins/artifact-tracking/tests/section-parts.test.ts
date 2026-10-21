// The parts of a section that the trackers share (core/lib/rows.ts) and the text of a web row. Pure.
// Plan: L5 Task 13, L6 A1.
import { expect, test } from 'claude-code/testing'
import {
  extrasOf,
  itemRow,
  lastRefreshOf,
  levelCell,
  sortedByLevel,
  textCells,
  toned,
  viaPrefix,
} from '../core/lib/rows'
import { webRow } from '../trackers/web/rows'
import type { WebRecord } from '../trackers/web/types'
import { reasonsOfSources } from './fixtures/reasons'

test('toned maps a tone to a color token, dim to the dim flag, and plain to nothing', () => {
  expect(toned('a')).toEqual({ text: 'a' })
  expect(toned('a', 'plain')).toEqual({ text: 'a' })
  expect(toned('a', 'ok')).toEqual({ text: 'a', fg: 'success' })
  expect(toned('a', 'warn')).toEqual({ text: 'a', fg: 'warning' })
  expect(toned('a', 'bad')).toEqual({ text: 'a', fg: 'error' })
  expect(toned('a', 'dim')).toEqual({ text: 'a', dim: true })
})

test('levelCell draws the glyph of a level, dim when a rule gave it, and nothing for no level', () => {
  expect(levelCell({})).toEqual({ text: '' })
  expect(levelCell({ level: 'normal' })).toEqual({ text: '' })
  expect(levelCell({ level: 'high' })).toEqual({ text: '▲' })
  expect(levelCell({ level: 'low' })).toEqual({ text: '▽' })
  expect(levelCell({ level: 'top', auto: true })).toEqual({ text: '★', dim: true })
})

test('textCells sets a cell for each field that is given, in the shared columns, and the link on the name', () => {
  expect(textCells({ key: 'k', title: 't' })).toEqual({ name: { text: 'k' }, description: { text: 't' } })
  expect(textCells({ key: 'k', href: '', title: 't' }).name).toEqual({ text: 'k' }) // an empty link is no link
  expect(
    textCells({
      key: 'k',
      href: 'https://x',
      title: 't',
      type: 'T',
      status: 's',
      tone: 'bad',
      extra: 'e',
      extraTone: 'ok',
      mark: 'm',
    }),
  ).toEqual({
    name: { text: 'k', href: 'https://x' },
    description: { text: 't' },
    type: { text: 'T' },
    status: { text: 's', fg: 'error' },
  }) // the extra and the mark are badges: see extrasOf
})

test('textCells: a clip on the title or on the type rides on its cell, and the other cells keep the clip of the column', () => {
  expect(textCells({ key: 'k', title: 't', type: 'T', titleClip: 'middle', typeClip: 'middle' })).toEqual({
    name: { text: 'k' },
    description: { text: 't', clip: 'middle' },
    type: { text: 'T', clip: 'middle' },
  })
  expect(textCells({ key: 'k', title: 't', type: 'T' }).type).toEqual({ text: 'T' })
})

test('extrasOf: the extra, then the mark (dim), as badges; one with no text is left out', () => {
  expect(extrasOf({ key: 'k', title: 't' })).toEqual([])
  expect(extrasOf({ key: 'k', title: 't', extra: 'e', extraTone: 'ok', mark: 'm' })).toEqual([
    { text: 'e', fg: 'success' },
    { text: 'm', dim: true },
  ])
  expect(extrasOf({ key: 'k', title: 't', extra: '', mark: 'm' })).toEqual([{ text: 'm', dim: true }])
  expect(extrasOf({ key: 'k', title: 't', extra: 'e', mark: '' })).toEqual([{ text: 'e' }])
})

test('itemRow: the control cell, the cells, a mark that anyone can set, and the children open by default', () => {
  const kid = itemRow({ id: 'a/b', owner: 'o', level: {}, dismiss: false, text: { key: 'b', title: 'B' } })
  expect(kid).toEqual({
    id: 'a/b',
    owner: 'o',
    cells: { control: { text: '' }, name: { text: 'b' }, description: { text: 'B' } },
    can: { dismiss: false, priority: true },
  })
  const root = itemRow({
    id: 'a',
    owner: 'o',
    level: { level: 'high' },
    dismiss: true,
    dim: true,
    children: [kid],
    text: { key: 'a', title: 'A' },
  })
  expect(root.children).toEqual([kid])
  expect(root.expandedByDefault).toBe(true)
  expect(root.dim).toBe(true)
  expect(root.cells.control).toEqual({ text: '▲' })
  expect(
    itemRow({ id: 'e', owner: 'o', level: {}, dismiss: true, children: [], text: { key: 'e', title: 'E' } }).children,
  ).toBeUndefined()
})

test('itemRow: the extra and the mark become the badges of the row, and a row with none has no extras', () => {
  const badged = itemRow({
    id: 'a',
    owner: 'o',
    level: {},
    dismiss: true,
    text: { key: 'a', title: 'A', extra: '✗ checks', extraTone: 'bad', mark: 'subagent' },
  })
  expect(badged.extras).toEqual([
    { text: '✗ checks', fg: 'error' },
    { text: 'subagent', dim: true },
  ])
  expect(badged.cells).not.toHaveProperty('extra')
  expect(badged.cells).not.toHaveProperty('mark')
  const plain = itemRow({ id: 'b', owner: 'o', level: {}, dismiss: true, text: { key: 'b', title: 'B', extra: '' } })
  expect('extras' in plain).toBe(false)
})

test('sortedByLevel: higher level first, then the first sighting, then the tie-break; the input stays', () => {
  const at = (key: string, firstSeen: number) => ({ key, firstSeen })
  const list = [at('a', 3), at('b', 1), at('c', 2), at('d', 1), at('e', 1)]
  const level = (key: string) => (key === 'c' ? { level: 'high' as const } : {})
  expect(sortedByLevel(list, level).map(i => i.key)).toEqual(['c', 'b', 'd', 'e', 'a'])
  expect(sortedByLevel(list, level, (x, y) => y.key.localeCompare(x.key)).map(i => i.key)).toEqual([
    'c',
    'e',
    'd',
    'b',
    'a',
  ])
  expect(list.map(i => i.key)).toEqual(['a', 'b', 'c', 'd', 'e'])
})

test('lastRefreshOf is the latest refresh, or undefined when none was refreshed', () => {
  expect(lastRefreshOf([])).toBeUndefined()
  expect(lastRefreshOf([{}, { refreshedAt: 5 }, { refreshedAt: 9 }, { refreshedAt: 7 }])).toBe(9)
})

test('viaPrefix names the PRs that a PR body mentions, and nothing for keys that are not numbered', () => {
  expect(viaPrefix(undefined)).toBe('')
  expect(viaPrefix([])).toBe('')
  expect(viaPrefix(['gh:github.com/acme/web#7', 'gh:?#9', 'jira:x/ISS-1'])).toBe('↳#7,#9 ')
})

test('a web row shows the host and path of its URL as written; text that is not a URL stays', () => {
  const rec = (url: string): WebRecord => ({
    key: `web:${url}`,
    category: 'web',
    url,
    label: 'L',
    sources: ['prompt'],
    reasons: reasonsOfSources(['prompt']),
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  })
  const title = (url: string) => webRow(rec(url), { levelOf: () => ({}) }).cells.description?.text
  expect(title('https://user@docs.example:8080/a/b/?q=1#top')).toBe('user@docs.example:8080/a/b')
  expect(title('http://docs.example')).toBe('docs.example')
  expect(title('not a url')).toBe('not a url')
})

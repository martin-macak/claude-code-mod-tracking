// The pure rules of the marks (issue #138): toggle, prune, the words of the view line and the label of `x`. Pure.
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS } from '../core/infra/keys'
import type { FooterKey, SectionSpec, TreeRow } from '../core/interfaces/view'
import { dismissQuestion, markedSummary, pruned, relabelDismiss, rowIdsOf, sameIds, toggled } from '../core/lib/marks'
import { row, section } from './fixtures/sections'

test('toggled adds an id that is not marked and removes one that is, and leaves the list it got alone', () => {
  const cur = ['a', 'b']
  expect(toggled(cur, 'c')).toEqual(['a', 'b', 'c'])
  expect(toggled(cur, 'a')).toEqual(['b'])
  expect(toggled([], 'a')).toEqual(['a'])
  expect(cur).toEqual(['a', 'b'])
})

test('pruned keeps the ids that a tracker row holds, in order', () => {
  expect(pruned(['a', 'gone', 'c'], new Set(['a', 'c', 'd']))).toEqual(['a', 'c'])
  expect(pruned([], new Set(['a']))).toEqual([])
})

test('rowIdsOf lists the id of every row of every section, children included', () => {
  const kid = row('k', { name: 'kid' })
  const parent: TreeRow = row('p', { name: 'parent' }, { children: [kid] })
  const sections: SectionSpec[] = [section('one', [parent]), section('two', [row('q', { name: 'q' })])]
  expect([...rowIdsOf(sections)].sort()).toEqual(['k', 'p', 'q'])
})

test('sameIds compares two lists as sets of the same size', () => {
  expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true)
  expect(sameIds(['a'], ['a', 'b'])).toBe(false)
  expect(sameIds(['a', 'b'], ['a', 'c'])).toBe(false)
  expect(sameIds([], [])).toBe(true)
})

test('sameIds is right on its own for a list that repeats an id', () => {
  expect(sameIds(['a', 'a'], ['a', 'b'])).toBe(false)
  expect(sameIds(['a', 'b'], ['a', 'a'])).toBe(false)
  expect(sameIds(['a', 'a'], ['a'])).toBe(true) // the same ids, whatever the repeats
})

test('markedSummary adds the count of the marked rows to the words of the view line, and nothing for none', () => {
  expect(markedSummary('View: list', 0)).toBe('View: list')
  expect(markedSummary('View: list', 2)).toBe('View: list · 2 marked')
  expect(markedSummary('View: status · touched only · 3 hidden', 1)).toBe(
    'View: status · touched only · 3 hidden · 1 marked',
  )
})

test('dismissQuestion asks for the count and names the key that answers; one row reads in the singular', () => {
  expect(dismissQuestion(3)).toBe('Dismiss 3 marked rows? x again: yes')
  expect(dismissQuestion(1)).toBe('Dismiss 1 marked row? x again: yes')
})

const footer: FooterKey[] = CORE_KEYS.filter(k => k.bar !== 'view').map(k => ({ ...k, enabled: true, buttonKey: k.id }))
const labelOf = (keys: readonly FooterKey[], id: string) => keys.find(k => k.id === id)?.label

test('relabelDismiss puts the count on x, and confirm while the question stands; the other keys keep their label', () => {
  expect(labelOf(relabelDismiss(footer, 3, false), 'dismiss')).toBe('dismiss 3')
  expect(labelOf(relabelDismiss(footer, 3, true), 'dismiss')).toBe('confirm 3')
  expect(relabelDismiss(footer, 3, false).filter(k => k.id !== 'dismiss')).toEqual(
    footer.filter(k => k.id !== 'dismiss'),
  )
  expect(relabelDismiss(footer, 0, false)).toBe(footer) // no target: the label stays `dismiss`
})

test('relabelDismiss follows the confirm flag of a key, not its id', () => {
  const plain: FooterKey = {
    id: 'dismiss',
    key: 'x',
    label: 'dismiss',
    scope: 'row',
    owner: 'core',
    enabled: true,
    buttonKey: 'dismiss',
  }
  const asks: FooterKey = { ...plain, id: 'sweep', label: 'sweep', buttonKey: 'sweep', confirm: true }
  expect(labelOf(relabelDismiss([asks], 2, false), 'sweep')).toBe('sweep 2')
  expect(labelOf(relabelDismiss([asks], 2, true), 'sweep')).toBe('confirm 2')
  expect(relabelDismiss([plain], 2, false)).toEqual([plain])
})

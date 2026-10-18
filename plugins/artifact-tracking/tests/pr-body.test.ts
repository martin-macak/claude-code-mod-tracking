// PR body scan: strip comments, run the matchers, add closing refs, drop the self ref, cap. Pure.
import { expect, test } from 'claude-code/testing'
import { LIMITS } from '../hooks/contracts'
import { keyOf } from '../hooks/model/keys'
import { prBodyRefs, stripHtmlComments } from '../trackers/github/pr-body'
import { BODY_WITH_COMMENT, discovered } from './fixtures/gh-discovery'

const keys = (body: string, over = {}) => prBodyRefs(discovered({ body, ...over }), []).map(keyOf)

test('stripHtmlComments replaces a comment with one space', () => {
  expect(stripHtmlComments('a<!-- x -->b')).toBe('a b')
  expect(stripHtmlComments('<!-- one -->x<!-- two -->')).toBe(' x ')
  expect(stripHtmlComments('no comment')).toBe('no comment')
})

test('stripHtmlComments: an unclosed comment removes the rest of the text', () => {
  expect(stripHtmlComments('keep #5 <!-- #6 and more')).toBe('keep #5 ')
})

test('stripHtmlComments: the first --> ends a comment, as GitHub renders it', () => {
  expect(stripHtmlComments('<!-- a <!-- b --> #5 -->')).toBe('  #5 -->')
})

test('stripHtmlComments: <!--> is not a closed comment, so it removes the rest of the text', () => {
  expect(stripHtmlComments('a <!--> #5')).toBe('a ')
  expect(keys('a <!--> #5')).toEqual([])
})

test('stripHtmlComments: many openers and one closer give one comment, and many closed comments keep their order', () => {
  // A naive scan that rescans for `-->` from every opener is quadratic here. The first `-->` ends the comment.
  expect(stripHtmlComments('<!--'.repeat(100_000) + '-->')).toBe(' ')
  expect(stripHtmlComments('x' + '<!--'.repeat(100_000) + '-->y')).toBe('x y')
  expect(stripHtmlComments('<!--'.repeat(100_000))).toBe('')
  expect(stripHtmlComments('<!-- x -->'.repeat(50_000)).length).toBe(50_000)
})

test('a ref inside an HTML comment gives nothing', () => {
  expect(keys('<!-- see #12 -->')).toEqual([])
})

test('a nested comment: the ref after the first --> still counts', () => {
  expect(keys('<!-- a <!-- b --> #5 -->')).toEqual(['gh:github.com/acme/web#5'])
})

test('bare #N resolves to the PR repo; o/r#N and URLs keep theirs', () => {
  expect(keys('Part of #3 and other/repo#9 and https://github.com/third/proj/issues/4').sort()).toEqual([
    'gh:github.com/acme/web#3',
    'gh:github.com/other/repo#9',
    'gh:github.com/third/proj#4',
  ])
})

test('closing refs become issue refs with their URL, before the text refs', () => {
  const refs = prBodyRefs(
    discovered({
      body: 'Closes #1 and #2',
      closing: [
        { host: 'github.com', owner: 'acme', repo: 'web', number: 1, url: 'https://github.com/acme/web/issues/1' },
      ],
    }),
    [],
  )
  expect(refs.map(keyOf)).toEqual(['gh:github.com/acme/web#1', 'gh:github.com/acme/web#2'])
  expect(refs[0]).toMatchObject({ category: 'github', type: 'issue', url: 'https://github.com/acme/web/issues/1' })
})

test('a closing ref in another repo keeps that repo', () => {
  const refs = prBodyRefs(
    discovered({
      closing: [{ host: 'github.com', owner: 'o', repo: 'r', number: 5, url: 'https://github.com/o/r/issues/5' }],
    }),
    [],
  )
  expect(refs.map(keyOf)).toEqual(['gh:github.com/o/r#5'])
})

test('the PR own ref is dropped, as number and as URL', () => {
  expect(keys('Part of #7. See https://github.com/acme/web/pull/7', { number: 7 })).toEqual([])
})

test('Jira and web URLs become refs; the commented ref and the self ref do not', () => {
  const refs = prBodyRefs(discovered({ body: BODY_WITH_COMMENT }), [])
  expect(refs.map(keyOf).sort()).toEqual(
    ['gh:github.com/acme/web#1', 'jira:acme.atlassian.net/ISS-9', 'web:https://example.com/spec'].sort(),
  )
})

test('refs are unique and capped at maxBodyRefs', () => {
  const body = Array.from({ length: 80 }, (_, i) => `#${i + 100}`).join(' ') + ' #100'
  const refs = prBodyRefs(discovered({ body }), [])
  expect(refs).toHaveLength(LIMITS.maxBodyRefs)
  expect(new Set(refs.map(keyOf)).size).toBe(LIMITS.maxBodyRefs)
})

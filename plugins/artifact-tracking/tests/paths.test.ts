// The lexical path helpers of core/lib/paths.ts. Moved from tests/files.test.ts with the helpers (issue #49). Pure.
import { expect, test } from 'claude-code/testing'
import { isAbsolutePath, normalizePath, relativeToRoot } from '../core/lib/paths'

test('normalizePath: folds ., .., // and backslashes; keeps a drive letter', () => {
  expect(normalizePath('/work/docs/../docs/./plan.md')).toBe('/work/docs/plan.md')
  expect(normalizePath('/work//docs/plan.md')).toBe('/work/docs/plan.md')
  expect(normalizePath('C:\\work\\docs\\..\\a.md')).toBe('C:/work/a.md')
  expect(normalizePath('/../a.md')).toBe('/a.md')
  expect(normalizePath('a/../../b.md')).toBe('../b.md')
})

test('relativeToRoot: under the root gives the rest; the root itself, outside and a look-alike stay absolute', () => {
  expect(relativeToRoot('/work/docs/plan.md', '/work')).toBe('docs/plan.md')
  expect(relativeToRoot('/work/docs/plan.md', '/work/')).toBe('docs/plan.md')
  expect(relativeToRoot('/elsewhere/a.md', '/work')).toBe('/elsewhere/a.md')
  expect(relativeToRoot('/workshop/a.md', '/work')).toBe('/workshop/a.md')
  expect(relativeToRoot('/work/../etc/a.md', '/work')).toBe('/etc/a.md')
})

test('isAbsolutePath: a leading slash or a drive letter with a separator', () => {
  expect(isAbsolutePath('/work/a.md')).toBe(true)
  expect(isAbsolutePath('C:\\work\\a.md')).toBe(true)
  expect(isAbsolutePath('C:/work/a.md')).toBe(true)
  expect(isAbsolutePath('work/a.md')).toBe(false)
  expect(isAbsolutePath('C:a.md')).toBe(false)
})

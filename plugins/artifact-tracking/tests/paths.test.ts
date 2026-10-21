// The lexical path helpers of core/lib/paths.ts. Moved from tests/files.test.ts with the helpers (issue #49). Pure.
import { expect, test } from 'claude-code/testing'
import { baseName, dirName, isAbsolutePath, normalizePath, relativeToRoot } from '../core/lib/paths'

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

test('baseName: the last part of a path, folded as normalizePath folds it; a path with no part gives itself', () => {
  expect(baseName('/work/docs/plan.md')).toBe('plan.md')
  expect(baseName('docs/plan.md')).toBe('plan.md')
  expect(baseName('plan.md')).toBe('plan.md')
  expect(baseName('/work//docs/./x/../plan.md')).toBe('plan.md')
  expect(baseName('C:\\work\\a.md')).toBe('a.md')
  expect(baseName('/work/docs/')).toBe('docs')
  expect(baseName('/')).toBe('/')
  expect(baseName('')).toBe('')
})

test('dirName: everything before the last part, folded; empty for a path of one part; the root for a root file', () => {
  expect(dirName('/work/docs/plan.md')).toBe('/work/docs')
  expect(dirName('docs/plan.md')).toBe('docs')
  expect(dirName('docs/a/plan.md')).toBe('docs/a')
  expect(dirName('plan.md')).toBe('')
  expect(dirName('')).toBe('')
  expect(dirName('/work//docs/./x/../plan.md')).toBe('/work/docs')
  expect(dirName('C:\\work\\a.md')).toBe('C:/work')
  expect(dirName('/plan.md')).toBe('/')
  expect(dirName('C:/a.md')).toBe('C:/')
})

// The branch names that may stand in a git argument (issue #254, m4 of the review of #289): one rule in core, for every tracker.
import { expect, test } from 'claude-code/testing'
import { isSafeRef } from '../core/lib/git'

test('isSafeRef: a plain branch name passes', () => {
  for (const good of ['main', 'feat/auto-tracking', 'fix/BUG-3184_x', 'release/1.2.x', 'user+bot/a@b', '_x', '0.1']) {
    expect(isSafeRef(good), good).toBe(true)
  }
})

test('isSafeRef: an option, a revision expression, a shell character, an empty part or a name git refuses is not a name', () => {
  for (const bad of [
    '',
    '-x',
    '.hidden',
    'a..b',
    'a b',
    'a;b',
    'a`b',
    'a"b',
    '$(id)',
    'a^',
    'a~1',
    'a:b',
    '@{u}',
    'a{b',
    'a//b',
    'a/',
    'a.',
    'a.lock',
    'a\nb',
  ]) {
    expect(isSafeRef(bad), JSON.stringify(bad)).toBe(false)
  }
})

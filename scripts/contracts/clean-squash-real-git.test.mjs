// #243 against a real git. The kit tests of `/track clean` (plugins/artifact-tracking/tests/clean-worktrees-live.test.ts) fake
// git; the kit has no fs and no process. This test runs `appliedOf` over a temp repo, so it checks the words of the real
// `git merge-tree --write-tree`: the tree sha is the first line, a squash merge counts as applied, and a change that is not on
// the base, or that the base reverted later, does not. It needs git 2.38 or newer and skips without it.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/clean-squash-real-git.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appliedOf } from '../../plugins/artifact-tracking/trackers/auto/clean.ts'

const BASE = 'refs/heads/main'

/**
 * Whether this git has `merge-tree --write-tree` (2.38). The probe merges a commit with itself in a temp repo. `--help` is no
 * probe: git prints its usage and exits 129 even where the option exists (2.43).
 */
const hasMergeTree = () => {
  const dir = mkdtempSync(join(tmpdir(), 'clean-probe-'))
  try {
    const g = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        stdio: 'ignore',
      })
    g('init', '-q', '-b', 'main')
    g('commit', '-q', '--allow-empty', '-m', 'probe')
    g('merge-tree', '--write-tree', 'HEAD', 'HEAD')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('real git: a squash merge counts as applied; an unmerged change and a reverted squash do not', {
  skip: !hasMergeTree(),
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clean-squash-'))
  try {
    const g = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
      })
    const run = async argv => {
      try {
        return { exitCode: 0, stdout: g(...argv), stderr: '' }
      } catch (e) {
        return { exitCode: e.status ?? 1, stdout: '', stderr: String(e) }
      }
    }
    g('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a'), '1\n')
    g('add', 'a')
    g('commit', '-q', '-m', 'base')
    g('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'a'), '2\n')
    g('commit', '-q', '-am', 'one')
    writeFileSync(join(dir, 'b'), 'x\n')
    g('add', 'b')
    g('commit', '-q', '-m', 'two')
    const head = g('rev-parse', 'HEAD').trim()
    g('checkout', '-q', 'main')
    assert.equal(await appliedOf(run, head, [BASE]), undefined)
    g('merge', '--squash', 'feature')
    g('commit', '-q', '-m', 'squash')
    assert.equal(await appliedOf(run, head, [BASE]), BASE)
    g('rm', '-q', 'b')
    g('commit', '-q', '-m', 'revert part')
    assert.equal(await appliedOf(run, head, [BASE]), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real git: a custom merge driver that keeps the base never lets an unmerged change count as applied', {
  skip: !hasMergeTree(),
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clean-driver-'))
  try {
    const g = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
      })
    const run = async argv => {
      try {
        return { exitCode: 0, stdout: g(...argv), stderr: '' }
      } catch (e) {
        return { exitCode: e.status ?? 1, stdout: '', stderr: String(e) }
      }
    }
    g('init', '-q', '-b', 'main')
    g('config', 'merge.keepbase.driver', 'true')
    writeFileSync(join(dir, '.gitattributes'), 'a merge=keepbase\n')
    writeFileSync(join(dir, 'a'), '1\n')
    g('add', '.')
    g('commit', '-q', '-m', 'base')
    g('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'a'), 'feature\n')
    g('commit', '-q', '-am', 'one')
    const head = g('rev-parse', 'HEAD').trim()
    g('checkout', '-q', 'main')
    writeFileSync(join(dir, 'a'), 'main\n')
    g('commit', '-q', '-am', 'other')
    assert.equal(await appliedOf(run, head, [BASE]), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

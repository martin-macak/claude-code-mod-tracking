// The files of a conflicted PR (issue #50, P2): two git calls, a fetch of the base and the head, then `git merge-tree`.
// Pure around an injected runner. The merge-tree outputs are the ones git 2.56.0 printed in a scratch repo.
import { expect, test } from 'claude-code/testing'
import type { RunResult } from '../core/interfaces/ports'
import { CONFLICT_CAP, conflictFiles, type GitRun } from '../trackers/github/conflict-files'

const OID = '3ee957a877544efaf8eea208694fdcd92da716bc'
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const bad = (exitCode: number, stderr: string, stdout = ''): RunResult => ({ exitCode, stdout, stderr })

const O = { cwd: '/x/wt', head: 'feat/a', base: 'main', timeoutMs: 5000 }

function rig(answers: (argv: readonly string[]) => RunResult | Error) {
  const calls: { argv: readonly string[]; cwd: string; timeoutMs: number }[] = []
  const git: GitRun = async (argv, opts) => {
    calls.push({ argv: [...argv], ...opts })
    const a = answers(argv)
    if (a instanceof Error) throw a
    return a
  }
  return { git, calls }
}

const FETCH_OK = (argv: readonly string[]) => (argv[1] === 'fetch' ? ok() : undefined)

test('conflictFiles fetches the base and the head into their remote-tracking refs, then asks merge-tree', async () => {
  const r = rig(argv => FETCH_OK(argv) ?? bad(1, '', `${OID}\0src/a.ts\0src/b.ts\0`))
  const out = await conflictFiles(r.git, O)
  expect(out).toEqual({ files: ['src/a.ts', 'src/b.ts'] })
  expect(r.calls.map(c => c.argv)).toEqual([
    [
      'git',
      'fetch',
      '--no-tags',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
      '+refs/heads/feat/a:refs/remotes/origin/feat/a',
    ],
    ['git', 'merge-tree', '-z', '--write-tree', '--name-only', '--no-messages', 'origin/main', 'origin/feat/a'],
  ])
  expect(r.calls.every(c => c.cwd === '/x/wt' && c.timeoutMs === 5000)).toBe(true)
})

test('a merge with no conflict (exit 0, only the tree) is an empty list: the local refs differ from GitHub', async () => {
  const r = rig(argv => FETCH_OK(argv) ?? ok(`${OID}\0`))
  expect(await conflictFiles(r.git, O)).toEqual({ files: [] })
})

test('a name with a space or a non-ASCII letter comes out as written, and each name once', async () => {
  const r = rig(argv => FETCH_OK(argv) ?? bad(1, '', `${OID}\0a b.txt\0café.txt\0a b.txt\0`))
  expect(await conflictFiles(r.git, O)).toEqual({ files: ['a b.txt', 'café.txt'] })
})

test('the names past the cap are counted, not listed', async () => {
  const names = Array.from({ length: CONFLICT_CAP + 5 }, (_, i) => `f${i}.ts`)
  const r = rig(argv => FETCH_OK(argv) ?? bad(1, '', `${OID}\0${names.join('\0')}\0`))
  const out = await conflictFiles(r.git, O)
  expect(out).toEqual({ files: names.slice(0, CONFLICT_CAP), more: 5 })
  const small = await conflictFiles(r.git, { ...O, cap: 2 })
  expect(small).toEqual({ files: ['f0.ts', 'f1.ts'], more: CONFLICT_CAP + 3 })
})

test('the messages section after an empty name is not a file', async () => {
  const r = rig(argv => FETCH_OK(argv) ?? bad(1, '', `${OID}\0a.ts\0\0Auto-merging a.ts\0CONFLICT (content): x\0`))
  expect(await conflictFiles(r.git, O)).toEqual({ files: ['a.ts'] })
})

test('a failed fetch is the error, with its first line, and merge-tree does not run', async () => {
  const r = rig(argv =>
    argv[1] === 'fetch' ? bad(128, "fatal: 'origin' does not appear to be a git repository\nmore") : ok(),
  )
  expect(await conflictFiles(r.git, O)).toEqual({
    error: "git fetch failed: fatal: 'origin' does not appear to be a git repository",
  })
  expect(r.calls).toHaveLength(1)
})

test('a missing ref is an error, not a conflict: exit 1 with no tree on stdout', async () => {
  const r = rig(argv => FETCH_OK(argv) ?? bad(1, 'merge-tree: origin/feat/a - not something we can merge'))
  expect(await conflictFiles(r.git, O)).toEqual({
    error: 'git merge-tree failed: merge-tree: origin/feat/a - not something we can merge',
  })
})

test('a git too old for --write-tree says which git it needs', async () => {
  const r = rig(argv => FETCH_OK(argv) ?? bad(129, "error: unknown option `write-tree'\nusage: git merge-tree"))
  expect(await conflictFiles(r.git, O)).toEqual({ error: 'git merge-tree needs git 2.38 or newer' })
})

test('an exit with no message names the code; a call that rejects (a timeout, git missing) is the error', async () => {
  expect(await conflictFiles(rig(argv => FETCH_OK(argv) ?? bad(2, '')).git, O)).toEqual({
    error: 'git merge-tree failed: exit 2',
  })
  expect(await conflictFiles(rig(() => new Error('timed out after 5000 ms')).git, O)).toEqual({
    error: 'timed out after 5000 ms',
  })
})

test('the remote and the cap are parameters', async () => {
  const r = rig(argv => FETCH_OK(argv) ?? bad(1, '', `${OID}\0a.ts\0`))
  await conflictFiles(r.git, { ...O, remote: 'upstream' })
  expect(r.calls[0]?.argv.slice(3)).toEqual([
    'upstream',
    '+refs/heads/main:refs/remotes/upstream/main',
    '+refs/heads/feat/a:refs/remotes/upstream/feat/a',
  ])
  expect(r.calls[1]?.argv.slice(-2)).toEqual(['upstream/main', 'upstream/feat/a'])
})

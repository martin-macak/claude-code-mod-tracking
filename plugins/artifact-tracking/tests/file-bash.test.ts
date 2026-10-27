// The files a Bash command changed (issue #57, R4a), read from `bashEditDiff`. The shapes are the ones of probe P1 of the
// design study, on Claude Code 2.1.310, and the field of the 2.1.302 types. Pure.
import { expect, test } from 'claude-code/testing'
import { bashTouches } from '../trackers/file/bash'

/** The answer of a Bash call with a `bashEditDiff`. */
const bash = (bashEditDiff: unknown, over: Record<string, unknown> = {}) => ({
  result: { stdout: '', stderr: '', interrupted: false, bashEditDiff },
  ...over,
})
/** One hunk as the typings give it (`bashEditDiff.files[].hunks`). */
const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
/** A file of `files[]`: a modified file has a hunk and no flag; a created file has none (probe P1). */
const file = (filePath: string, flag?: 'created' | 'deleted') => ({
  filePath,
  hunks: flag === 'created' ? [] : [hunk],
  ...(flag ? { [flag]: true as const } : {}),
})
const diff = (...files: { filePath: string }[]) => ({ files, moreFiles: 0, changedFiles: files.map(f => f.filePath) })

test('a modified file has no flag and is edited; created and deleted say so', () => {
  expect(bashTouches(bash(diff(file('/r/src/a.ts'))))).toEqual([{ spelled: '/r/src/a.ts', kind: 'edited' }])
  expect(bashTouches(bash(diff(file('/r/out.txt', 'created'))))).toEqual([{ spelled: '/r/out.txt', kind: 'created' }])
  expect(bashTouches(bash(diff(file('/r/notes.md', 'deleted'))))).toEqual([{ spelled: '/r/notes.md', kind: 'deleted' }])
})

test('cp, mv and touch: every file of files[] with its flag, in the order the engine gave', () => {
  const got = bashTouches(bash(diff(file('/r/t.log', 'created'), file('/r/c3.json', 'created'))))
  expect(got).toEqual([
    { spelled: '/r/t.log', kind: 'created' },
    { spelled: '/r/c3.json', kind: 'created' },
  ])
})

test('a path of changedFiles that files does not show is edited; a path in both comes once, with the flag of files', () => {
  const d = {
    files: [file('/r/a.ts', 'created')],
    moreFiles: 2,
    changedFiles: ['/r/a.ts', '/r/b.ts', '/r/c.ts'],
  }
  expect(bashTouches(bash(d))).toEqual([
    { spelled: '/r/a.ts', kind: 'created' },
    { spelled: '/r/b.ts', kind: 'edited' },
    { spelled: '/r/c.ts', kind: 'edited' },
  ])
})

test('the flags unavailable, skipped and shared do not hide the files that are named', () => {
  for (const flag of ['unavailable', 'skipped', 'shared'])
    expect(bashTouches(bash({ ...diff(file('/r/a.ts')), [flag]: true }))).toEqual([
      { spelled: '/r/a.ts', kind: 'edited' },
    ])
  // `skipped` (git checkout, git stash) takes no diff: nothing is named, nothing is added.
  expect(bashTouches(bash({ files: [], moreFiles: 0, skipped: true }))).toEqual([])
})

test('no field adds nothing', () => {
  expect(bashTouches({ result: { stdout: 'x', stderr: '', interrupted: false, isImage: false } })).toEqual([])
  for (const none of [null, undefined, 'text', 4, [], { result: 'Error: x', isError: true }, { result: null }])
    expect(bashTouches(none)).toEqual([])
})

test('an odd field adds nothing, and a path of changedFiles that is no string is skipped', () => {
  const odd = [null, 'text', 3, [], {}, { files: 'x', changedFiles: 4 }, { files: [null, 3, {}, { filePath: '' }] }]
  for (const field of odd) expect(bashTouches(bash(field))).toEqual([])
  expect(bashTouches(bash({ changedFiles: [1, null, '', '/r/ok.ts'] }))).toEqual([
    { spelled: '/r/ok.ts', kind: 'edited' },
  ])
})

test('a read-only call adds nothing', () => {
  expect(bashTouches({ isReadOnly: true, result: { stdout: 'x' } })).toEqual([])
})

test('a denied call and a staged call add nothing', () => {
  expect(bashTouches({ deny: 'blocked by a hook' })).toEqual([])
  expect(bashTouches(bash(diff(file('/r/a.ts')), { deny: 'no' }))).toEqual([])
  expect(bashTouches({ result: { ...bash(diff(file('/r/a.ts'))).result, staged: true } })).toEqual([])
})

test('a failed call still counts the files the engine names: the field says what changed on disk', () => {
  expect(bashTouches(bash(diff(file('/r/a.ts')), { isError: true }))).toEqual([{ spelled: '/r/a.ts', kind: 'edited' }])
})

test('a transcript tool use has the same shape and gives the same touches', () => {
  const use = {
    tool_use_id: 't1',
    tool: 'Bash',
    input: { command: 'rm notes.md' },
    ...bash(diff(file('/r/notes.md', 'deleted'))),
  }
  expect(bashTouches(use)).toEqual([{ spelled: '/r/notes.md', kind: 'deleted' }])
})

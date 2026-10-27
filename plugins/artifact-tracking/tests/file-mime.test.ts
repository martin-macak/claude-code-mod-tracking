// The type of a file that the map does not know (issue #57, R7): one `file -b --mime-type` call, off the tool.call path, kept
// on the record. The fake `file` answers through `w.run`; the job starts with `clock.after(0)`, so a test moves the fake clock
// and the job has run when `advance` returns. Through the LifecycleManager over fakePorts: the tool probe, the tracker events
// and the item store are the real ones.
import { expect, test } from 'claude-code/testing'
import type { RunResult } from '../core/interfaces/ports'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { fileTracker } from '../trackers/file'
import { fakeConfig } from './fixtures/config-fs'
import type { FileRecord } from './fixtures/contracts'
import { res } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

const created = (filePath: string) => ({
  type: 'create',
  filePath,
  content: 'x',
  structuredPatch: [],
  originalFile: null,
})
const viewed = (filePath: string) => ({
  type: 'text',
  file: { filePath, content: 'x', numLines: 1, startLine: 1, totalLines: 1 },
})

type FileAnswer = (path: string) => RunResult | Promise<RunResult>

/** The result fields of a Bash call that created `path`, as the engine reports them (`bashEditDiff`). */
const made = (path: string) => ({
  bashEditDiff: { files: [{ filePath: path, hunks: [], created: true }], moreFiles: 0, changedFiles: [path] },
})

/** A world with the file tracker alone. `file` answers `answer`; `version` answers the probe (default: ok). */
function world(
  o: { answer?: FileAnswer; mime?: boolean; version?: RunResult; slice?: Record<string, boolean | string> } = {},
) {
  const asked: string[] = []
  /** The waits of `reached`: resolved when the fake `file` has been asked `n` times. */
  const waiting: { n: number; go: () => void }[] = []
  const answer: FileAnswer = o.answer ?? (() => res('text/x-script.python\n'))
  const t = managerWorld({
    trackers: () => [fileTracker()],
    config: specs =>
      fakeConfig({
        specs,
        file: { version: 1, trackers: { file: { ...(o.mime === undefined ? {} : { mime: o.mime }), ...o.slice } } },
      }),
    run: async argv => {
      if (argv[0] !== 'file') return undefined
      if (argv[1] === '--version') return o.version ?? res('file-5.41\nmagic file from /usr/share/file/magic\n')
      asked.push(argv.slice(1).join(' '))
      for (const w of waiting) if (asked.length >= w.n) w.go()
      return answer(argv[argv.length - 1]!)
    },
  })
  t.w.env.HOME = '/home/u'
  const touch = (tool: 'Write' | 'Read', filePath: string) =>
    t.call(tool, { file_path: filePath }, { result: tool === 'Write' ? created(filePath) : viewed(filePath) })
  const rec = (path: string) => t.items().find(r => r.key === `file:${path}`) as FileRecord | undefined
  /** Moves the clock: the job that a call started has run when this returns. */
  const settle = () => t.w.clock.advance(0)
  /** Resolves when `file` has been asked `n` times: the job is then inside its call. */
  const reached = (n: number): Promise<void> =>
    asked.length >= n ? Promise.resolve() : new Promise<void>(go => waiting.push({ n, go }))
  return { ...t, asked, touch, rec, settle, reached }
}

test('a name the map does not know is typed once, off the hook path, and the answer sits on the record', async () => {
  const t = world()
  await t.touch('Write', '/work/run')
  expect(t.asked).toEqual([]) // the hook returned with no `file` call: the type is `other` for now
  expect(t.rec('/work/run')?.mime).toBeUndefined()
  await t.settle()
  expect(t.asked).toEqual(['-b --mime-type -- /work/run'])
  expect(t.rec('/work/run')?.mime).toBe('text/x-script.python')
})

test('a name the map knows is never asked, and a second call of a known path asks nothing', async () => {
  const t = world()
  for (const p of ['/work/a.ts', '/work/package.json', '/work/Makefile', '/work/.env', '/work/img.png'])
    await t.touch('Write', p)
  await t.settle()
  expect(t.asked).toEqual([])
  await t.touch('Write', '/work/run')
  await t.settle()
  await t.touch('Read', '/work/run')
  await t.settle()
  expect(t.asked).toEqual(['-b --mime-type -- /work/run']) // cached on the record: one call
})

test('a burst of unknown names is typed by one job, one file call each, in the order they came', async () => {
  const t = world({ answer: p => res(p.endsWith('b') ? 'image/png\n' : 'text/plain\n') })
  for (const p of ['/work/a', '/work/b', '/work/c']) await t.touch('Write', p)
  await t.settle()
  expect(t.asked).toEqual(['-b --mime-type -- /work/a', '-b --mime-type -- /work/b', '-b --mime-type -- /work/c'])
  expect(['a', 'b', 'c'].map(n => t.rec(`/work/${n}`)?.mime)).toEqual(['text/plain', 'image/png', 'text/plain'])
})

test('an answer that is no MIME type is kept as unknown, and the path is not asked again', async () => {
  const t = world({ answer: p => res(`cannot open \`${p}' (No such file or directory)\n`) })
  await t.touch('Write', '/work/ghost')
  await t.settle()
  expect(t.rec('/work/ghost')?.mime).toBe('unknown')
  await t.touch('Write', '/work/ghost')
  await t.settle()
  expect(t.asked).toHaveLength(1)
})

test('a failed call (exit 1) leaves the record as it is and is not tried again in this load', async () => {
  const t = world({ answer: () => res('', 1, 'boom') })
  await t.touch('Write', '/work/run')
  await t.settle()
  expect(t.rec('/work/run')?.mime).toBeUndefined()
  await t.touch('Write', '/work/run')
  await t.settle()
  expect(t.asked).toHaveLength(1)
})

test('without file on the host (the probe fails) nothing is asked and the type stays other', async () => {
  const t = world({ version: res('', 127, 'file: command not found') })
  await t.touch('Write', '/work/run')
  await t.settle()
  expect(t.asked).toEqual([])
  expect(t.rec('/work/run')?.mime).toBeUndefined()
  expect(t.rec('/work/run')).toBeDefined() // the row is there
})

test('mime: false asks nothing', async () => {
  const t = world({ mime: false })
  await t.touch('Write', '/work/run')
  await t.settle()
  expect(t.asked).toEqual([])
  expect(t.rec('/work/run')?.mime).toBeUndefined()
})

test('a file that Bash removed is not asked: it is not there', async () => {
  const t = world()
  const gone = {
    bashEditDiff: {
      files: [{ filePath: '/work/old', hunks: [], deleted: true }],
      moreFiles: 0,
      changedFiles: ['/work/old'],
    },
  }
  await t.call('Bash', { command: 'rm old' }, { result: { stdout: '', stderr: '', interrupted: false, ...gone } })
  await t.settle()
  expect(t.rec('/work/old')).toMatchObject({ deleted: true })
  expect(t.asked).toEqual([])
})

test('a restored record with no answer is typed on the next tick, with no tool call to start it', async () => {
  const t = world()
  await t.touch('Write', '/work/a.ts') // starts the load: the probe settles
  const stored = { ...t.rec('/work/a.ts')!, key: 'file:/work/late', url: '/work/late', label: '/work/late' }
  t.w.state.set('items', [...t.items(), stored] as never)
  expect(t.asked).toEqual([])
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs + 1) // one tick
  expect(t.asked).toEqual(['-b --mime-type -- /work/late'])
  expect(t.rec('/work/late')?.mime).toBe('text/x-script.python')
})

test('an answer that comes after a session switch is dropped: the generation moved', async () => {
  let release!: (r: RunResult) => void
  const held = new Promise<RunResult>(resolve => (release = resolve))
  const t = world({ answer: () => held })
  await t.touch('Write', '/work/run')
  const job = t.settle() // the job asks `file` and waits for the answer
  await t.reached(1)
  expect(t.asked).toEqual(['-b --mime-type -- /work/run'])
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports) // finds the new id: a switch, the generation moves
  const before = t.items().length
  release(res('text/plain\n'))
  await job
  expect(t.items().map(r => (r as FileRecord).mime)).toEqual(Array<undefined>(before).fill(undefined))
})

test('a Bash call that created a file the map does not know starts the job', async () => {
  const t = world()
  await t.call(
    'Bash',
    { command: 'make run' },
    { result: { stdout: '', stderr: '', interrupted: false, ...made('/work/run') } },
  )
  await t.settle()
  expect(t.asked).toEqual(['-b --mime-type -- /work/run'])
  expect(t.rec('/work/run')?.mime).toBe('text/x-script.python')
})

test('bashEdits false: a Bash call starts no job, and the file tools go on', async () => {
  const t = world({ slice: { bashEdits: false } })
  await t.call(
    'Bash',
    { command: 'make run' },
    { result: { stdout: '', stderr: '', interrupted: false, ...made('/work/run') } },
  )
  await t.settle()
  expect(t.asked).toEqual([])
  await t.touch('Write', '/work/other')
  await t.settle()
  expect(t.asked).toEqual(['-b --mime-type -- /work/other'])
})

test('scope md: a call that touched a file other than .md starts no job', async () => {
  const t = world({ slice: { scope: 'md' } })
  await t.touch('Write', '/work/run')
  await t.touch('Read', '/work/other')
  await t.settle()
  expect(t.asked).toEqual([])
  // The tick finds nothing to type either: the tracker keeps no row of such a file.
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs + 1)
  expect(t.asked).toEqual([])
})

test('a name that comes while the job waits for file is typed by the same job', async () => {
  let release!: (r: RunResult) => void
  const held = new Promise<RunResult>(resolve => (release = resolve))
  const answers = [held, res('text/plain\n')]
  const t = world({ answer: () => answers.shift() ?? res('text/plain\n') })
  await t.touch('Write', '/work/a')
  const job = t.settle()
  await t.reached(1)
  await t.touch('Write', '/work/b') // the job is busy: it must look again when it is done
  release(res('text/plain\n'))
  await job
  expect(t.asked).toEqual(['-b --mime-type -- /work/a', '-b --mime-type -- /work/b'])
  expect(t.rec('/work/b')?.mime).toBe('text/plain')
})

test('an open breaker stops the job: no further file call, and the records stay untyped', async () => {
  const { threshold } = GLOBAL_DEFAULTS.tools.breaker
  const names = Array.from({ length: threshold + 2 }, (_, i) => `/work/n${i}`)
  const t = world({ answer: () => res('', 1, 'boom') })
  for (const name of names) await t.touch('Write', name)
  await t.settle()
  expect(t.asked).toHaveLength(threshold) // each failure counts; the breaker opens at the threshold
  await t.touch('Write', '/work/late')
  await t.settle()
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs + 1)
  expect(t.asked).toHaveLength(threshold) // still open: nothing more is asked
  expect([...names, '/work/late'].map(n => t.rec(n)?.mime)).toEqual(Array<undefined>(names.length + 1).fill(undefined))
})

test('a call that cannot start leaves the name for the next pass, and the next name is still asked', async () => {
  let down = true
  const t = world({
    answer: p => {
      if (down && p.endsWith('/a')) throw new Error('spawn failed')
      return res('text/plain\n')
    },
  })
  await t.touch('Write', '/work/a')
  await t.touch('Write', '/work/b')
  await t.settle()
  expect(t.rec('/work/b')?.mime).toBe('text/plain') // the failed call of `a` did not end the pass
  expect(t.rec('/work/a')?.mime).toBeUndefined()
  down = false
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs + 1) // `a` was not marked tried: the tick asks again
  expect(t.rec('/work/a')?.mime).toBe('text/plain')
})

test('a job that fails is logged once, and the next call goes on', async () => {
  const t = world()
  await t.touch('Write', '/work/a') // the row is written; the job has not run yet
  const update = t.w.ports.state.items.update
  t.w.ports.state.items.update = async () => {
    throw new Error('store refused')
  }
  await t.settle() // the job gets the answer and cannot write it
  expect(t.w.logs.filter(l => l.startsWith('file:'))).toEqual(['file: type lookup failed: store refused'])
  expect(t.rec('/work/a')?.mime).toBeUndefined()
  t.w.ports.state.items.update = update
  await t.touch('Write', '/work/b') // the next call starts a job again
  await t.settle()
  expect(t.rec('/work/b')?.mime).toBe('text/x-script.python')
})

test('after /track clear, the same file is typed again: the answer went with the record, and so did the lookup', async () => {
  const t = world()
  await t.touch('Write', '/work/run')
  await t.settle()
  expect(t.rec('/work/run')?.mime).toBe('text/x-script.python')
  await t.m.clear(t.w.ports)
  expect(t.rec('/work/run')).toBeUndefined() // the record, with its answer, is gone
  await t.touch('Read', '/work/run')
  expect(t.rec('/work/run')?.mime).toBeUndefined() // the new record has no answer yet
  await t.settle()
  expect(t.asked).toEqual(['-b --mime-type -- /work/run', '-b --mime-type -- /work/run'])
  expect(t.rec('/work/run')?.mime).toBe('text/x-script.python')
})

test('after /track clear, a file whose lookup failed is asked again; before the clear it was not', async () => {
  const answers = [res('', 1, 'boom'), res('text/plain\n')]
  const t = world({ answer: () => answers.shift() ?? res('text/plain\n') })
  await t.touch('Write', '/work/run')
  await t.settle()
  await t.touch('Write', '/work/run')
  await t.settle()
  expect(t.asked).toHaveLength(1) // the failed path is not tried again in this load
  await t.m.clear(t.w.ports)
  await t.touch('Write', '/work/run')
  await t.settle()
  expect(t.asked).toHaveLength(2)
  expect(t.rec('/work/run')?.mime).toBe('text/plain')
})

test('a record that went and came back with no answer (a cap dropped it) is typed again', async () => {
  const t = world()
  await t.touch('Write', '/work/run')
  await t.settle()
  t.w.state.set('items', t.items().filter(r => r.key !== 'file:/work/run') as never)
  await t.touch('Read', '/work/run')
  await t.settle()
  expect(t.asked).toEqual(['-b --mime-type -- /work/run', '-b --mime-type -- /work/run'])
  expect(t.rec('/work/run')?.mime).toBe('text/x-script.python')
})

test('an answer that a session switch dropped is not lost: the record has none, so the next tick asks again', async () => {
  let release!: (r: RunResult) => void
  const held = new Promise<RunResult>(resolve => (release = resolve))
  const answers = [held, res('text/plain\n')]
  const t = world({ answer: () => answers.shift() ?? res('text/plain\n') })
  await t.touch('Write', '/work/run')
  const job = t.settle()
  await t.reached(1)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports) // a switch: the generation moves
  release(res('text/x-script.python\n'))
  await job
  expect(t.rec('/work/run')?.mime).toBeUndefined() // dropped
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs + 1)
  expect(t.asked).toHaveLength(2)
  expect(t.rec('/work/run')?.mime).toBe('text/plain')
})

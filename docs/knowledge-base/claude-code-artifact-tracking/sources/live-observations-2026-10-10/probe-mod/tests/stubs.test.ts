// How the kit stubs $-calls. The test's own `$` holds only the nouns the engine raises (tool, command,
// prompt, session.start/append/..., turn, ui, classic). It has no process, store, clock, env, state or
// session.repo. A test stubs those with on('process.run', ...) and the like; only the mod calls them.
import { expect, mock, test } from 'claude-code/testing'

test('a { deny } stub makes the mod\'s $.process.run reject with the reason (and a { value } stub resolves it)', async ($, on) => {
  const written: Record<string, string> = {}
  mock.clock(on)
  on('process.run', (_$, e) => (e.argv[0] === 'good' ? { value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : { deny: 'ENOENT boom' }))
  on('fs.write', (_$, e) => { written[e.path] = e.text; return { value: undefined } })
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: '/r' }))
  await $.command.run({ command: 'probe-run', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const file = Object.keys(written).find((p) => p.endsWith('probe-run.json'))!
  const a1 = (JSON.parse(written[file]!) as { label: string; ok: boolean; message?: string }[]).find((x) => x.label === 'A1 missing tool')!
  expect(a1.ok).toBe(false)
  expect(a1.message).toContain('ENOENT boom')
})

test('process.run without a stub: the mod\'s call fails with "no implementation"', async ($, on) => {
  const written: Record<string, string> = {}
  mock.clock(on)
  on('fs.write', (_$, e) => { written[e.path] = e.text; return { value: undefined } })
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: '/r' }))
  await $.command.run({ command: 'probe-run', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const file = Object.keys(written).find((p) => p.endsWith('probe-run.json'))!
  const a1 = (JSON.parse(written[file]!) as { label: string; message?: string }[]).find((x) => x.label === 'A1 missing tool')!
  expect(a1.message).toContain('no implementation')
})

test('the stub sees argv and init exactly as the mod passed them', async ($, on) => {
  const seen: unknown[] = []
  mock.clock(on)
  on('process.run', (_$, e) => { seen.push({ argv: e.argv, init: e.init }); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('fs.write', () => ({ value: undefined }))
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: '/r' }))
  await $.command.run({ command: 'probe-run', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(seen).toContainEqual({ argv: ['sleep', '5'], init: { timeoutMs: 1000 } })
  expect(seen).toContainEqual({ argv: ['pwd'], init: { cwd: '/tmp' } })
})

test('mock.store, mock.env, mock.clock answer the mod\'s $.store / $.env / $.clock; session.repo is a plain stub', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on, { 'probe-t6': 'seed' })
  mock.env(on, { HOME: '/h' })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 's' }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.command.run({ command: 'probe-timers', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await clock.advance(1000)
  const st = await $.command.run({ command: 'probe-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(st.text).toContain('entries=')
})

test('the test $ has no process, store, clock, env, state, session.repo', async ($) => {
  const t = $ as unknown as Record<string, Record<string, unknown> | undefined>
  expect(t.process).toBeUndefined()
  expect(t.store).toBeUndefined()
  expect(t.clock).toBeUndefined()
  expect(t.state).toBeUndefined()
  expect(t.session?.repo).toBeUndefined()
})

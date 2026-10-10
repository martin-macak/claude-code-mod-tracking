import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseRemote } from '../hooks/tools'

const ok = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const cmd = ($: any, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

/** Stubs for everything the probe calls. Register before the first `$` call. */
function world(on: On, run: (argv: readonly string[]) => unknown) {
  const clock = mock.clock(on)
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    const r = run(e.argv)
    return r && typeof r === 'object' && 'deny' in (r as object) ? (r as { deny: string }) : { value: r as ReturnType<typeof ok> }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, calls }
}

test('process.run stub: detection is cached; a missing tool is a rejection', async ($, on) => {
  const { calls } = world(on, (argv) => (argv[0] === 'gh' ? ok('gh version 2') : { deny: 'ENOENT: Executable not found in $PATH' }))
  await $.session.start({ cwd: '/x' } as never)
  const out = await cmd($, 'probe-avail')
  expect(out.text).toContain('"gh":true')
  expect(out.text).toContain('"gh2":true')
  expect(out.text).toContain('"missing":false')
  // gh once (cached), definitely-not-a-tool once
  expect(calls.filter((c) => c[0] === 'gh').length).toBe(1)
  expect(calls[0]).toEqual(['gh', '--version'])
})

test('session.repo stub: remote shapes', async ($, on) => {
  world(on, () => ok())
  on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  const out = await cmd($, 'probe-repo')
  expect(out.text).toContain('"internal":false')
  expect(out.text).toContain('"name":null')
})

test('session.repo stub: null', async ($, on) => {
  world(on, () => ok())
  on('session.repo', () => ({ value: null }))
  expect((await cmd($, 'probe-repo')).text).toContain('"repo":null')
})

test('timer callback: mock clock fires it; it calls process.run and writes $.state', async ($, on) => {
  const { clock, calls } = world(on, () => ok('gh version 2'))
  await cmd($, 'probe-timers')
  await clock.advance(400) // T1 (300 ms) fired
  const st = await cmd($, 'probe-status')
  expect(st.text).toContain('entries=')
  expect(calls.some((c) => c[0] === 'gh')).toBe(true)
  await clock.advance(3000)
  expect((await cmd($, 'probe-status')).text).toContain('ticks=3')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane tree table draws, collapses, and redraws when state is written (${surface})`, async ($, on) => {
    const { clock } = world(on, () => ok())
    await cmd($, 'probe-pane') // writes rows, opens pane, schedules a timer write at +3000
    const ui = await $.ui.mount({ plugin: 'probe', surface, component: 'Pane', requestId: 'probe-pane',
      viewport: { columns: 100, rows: 30 }, props: { title: 'Tracking', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} } } as never)
    expect(await ui.find({ text: 'Parent story' })).toBeDefined()
    expect(await ui.find({ text: 'Subtask' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.press({ key: 't-J1' })
    expect(await ui.find({ text: 'Subtask' })).toBeUndefined() // collapsed
    await ui.press({ key: 't-J1' })
    expect(await ui.find({ text: 'Subtask' })).toBeDefined()
    // write from a command hook: pane redraws without $.ui.invalidate
    await cmd($, 'probe-add')
    expect(await ui.find({ text: 'ADDED-BY-COMMAND' })).toBeDefined()
    // write from a timer callback
    await clock.advance(3100)
    expect(await ui.find({ text: 'ADDED-BY-TIMER' })).toBeDefined()
    await ui.unmount()
  })
}

test('parseRemote', () => {
  expect(parseRemote('git@github.com:o/r.git')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
  expect(parseRemote('https://github.com/o/r')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
  expect(parseRemote('https://user:tok@github.com/o/r.git')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
  expect(parseRemote('ssh://git@github.example.com:2222/o/r.git')).toEqual({ host: 'github.example.com', owner: 'o', repo: 'r' })
  expect(parseRemote(null)).toBeNull()
  expect(parseRemote('/local/path')).toBeNull()
})

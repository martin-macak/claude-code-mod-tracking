declare const console: { log(...a: unknown[]): void }
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const stubs = (on: On) => {
  const clock = mock.clock(on, { now: 100 })
  mock.store(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const files = new Map<string, string>()
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv.slice(1).join(' ') + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ result: 'engine' }))
  return clock
}

test('ports object: closures keep working in timers and later dispatches', async ($, on) => {
  const clock = stubs(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false } as never)
  // every(500) fires at 500; after(1000) fires at 1000 (and every at 1000)
  await clock.advance(1000)
  const r = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { deny: string }
  console.log('deny =', r.deny)
  const o = JSON.parse(r.deny) as Record<string, unknown>
  expect(o.run).toBe('hi')
  expect(o.cfg).toBe('sess-1')
  expect(o.has).toBe(true)
  expect(o.ticks).toBe(3) // every@500, every@1000, after@1000
  expect(o.state).toBe(3) // the state port bumped in each timer
  expect(o.stored).toMatchObject({ n: 3 })
  await clock.advance(500)
  const r2 = JSON.parse(((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { deny: string }).deny) as Record<string, unknown>
  expect(r2.ticks).toBe(4) // the interval still runs after a later dispatch
})

test('ports rebuilt per hook also work', async ($, on) => {
  stubs(on)
  const r = (await $.tool.call({ tool: 'Read', file_path: '/x' } as never)) as { deny: string }
  expect(r.deny).toBe('per-hook:sess-1:100')
})

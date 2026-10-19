// Tool base class: probe cache, exec rejection, outcome bookkeeping. Pure, fake Runner.
import { expect, test } from 'claude-code/testing'
import type { Outcome } from '../core/infra/tool'
import { Tool } from '../core/infra/tool'
import type { Runner, RunResult } from '../hooks/contracts'

const ok = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })

/** A concrete tool for tests: one call per refresh, outcome chosen by the test. */
class FakeTool extends Tool<string> {
  next: Outcome = 'ok'
  async refreshItems(items: string[]): Promise<void> {
    const r = await this.exec(['fake', 'go', ...items])
    if (r) this.record(this.next, r.stderr || undefined)
  }
}

function runner(answer: (argv: readonly string[]) => RunResult | Error) {
  const calls: string[][] = []
  const run: Runner = async argv => {
    calls.push([...argv])
    const a = answer(argv)
    if (a instanceof Error) throw a
    return a
  }
  return { run, calls }
}

test('probe runs --version once and caches the answer', async () => {
  const { run, calls } = runner(() => ok('fake version 1.2.3\nmore'))
  const t = new FakeTool('gh', run, () => 0)
  expect(t.isAvailable).toBe(false) // not probed yet
  expect(await t.probe()).toBe(true)
  expect(await t.probe()).toBe(true)
  expect(calls).toEqual([['gh', '--version']])
  expect(t.isAvailable).toBe(true)
  expect(t.status().version).toBe('fake version 1.2.3')
})

test('probe: a missing executable means not available, never a rejection', async () => {
  const { run } = runner(
    () =>
      new Error('artifact-tracking: $.process.run(gh) failed to start: ENOENT: Executable not found in $PATH: "gh"'),
  )
  const t = new FakeTool('gh', run, () => 0)
  expect(await t.probe()).toBe(false)
  expect(t.canCall(0)).toBe(false)
  expect(t.status()).toMatchObject({ available: false, breaker: 'closed' })
  expect(t.status().lastError).toContain('ENOENT')
})

test('exec rejection counts as a tool failure; three open the breaker', async () => {
  let fail = false
  const { run } = runner(argv => (argv[1] === '--version' ? ok('v') : fail ? new Error('timeout') : ok()))
  const t = new FakeTool('acli', run, () => 1000)
  await t.probe()
  fail = true
  for (let i = 0; i < 3; i++) await t.refreshItems(['x'])
  expect(t.status().breaker).toBe('open')
  expect(t.canCall(1000)).toBe(false)
})

test('an open breaker blocks exec without running the command', async () => {
  let fail = true
  const { run, calls } = runner(argv => (argv[1] === '--version' ? ok('v') : fail ? new Error('down') : ok()))
  let t0 = 0
  const t = new FakeTool('gh', run, () => t0)
  await t.probe()
  for (let i = 0; i < 3; i++) await t.refreshItems(['x'])
  const before = calls.length
  await t.refreshItems(['x'])
  expect(calls.length).toBe(before) // blocked, no call
  t0 = 5 * 60_000
  fail = false
  expect(t.canCall(t0)).toBe(true)
  expect(t.canCall(t0)).toBe(true) // canCall does not take the half-open slot
  await t.refreshItems(['x'])
  expect(t.status().breaker).toBe('closed')
})

test('auth outcome marks the tool logged out until reset', async () => {
  const { run } = runner(() => ok('v'))
  const t = new FakeTool('gh', run, () => 0)
  await t.probe()
  t.next = 'auth'
  await t.refreshItems(['x'])
  expect(t.status().loggedIn).toBe(false)
  expect(t.canCall(0)).toBe(false)
  t.reset()
  expect(t.status().loggedIn).toBe(null)
  expect(t.canCall(0)).toBe(true)
})

test('item-error is a success for the breaker', async () => {
  const { run } = runner(() => ok('v'))
  const t = new FakeTool('gh', run, () => 0)
  await t.probe()
  t.next = 'item-error'
  for (let i = 0; i < 5; i++) await t.refreshItems(['x'])
  expect(t.status()).toMatchObject({ breaker: 'closed', loggedIn: true })
})

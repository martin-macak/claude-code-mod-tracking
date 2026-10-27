import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { refusals, refuserSource, timerRefuserRefusal, writeTimerRefuser } from '../support/timer-refuser.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'timer-refuser-'))

test('the probe plugin has a manifest, a hooks file that names its module, and the module', () => {
  const dir = tempDir()
  const probe = writeTimerRefuser(dir, 10)
  assert.equal(probe.pluginDir, join(dir, 'plugin'))
  const manifest = JSON.parse(readFileSync(join(probe.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'timer-refuser')
  assert.deepEqual(JSON.parse(readFileSync(join(probe.pluginDir, 'hooks', 'hooks.json'), 'utf8')), {
    modules: ['./register.ts'],
  })
  assert.equal(readFileSync(join(probe.pluginDir, 'hooks', 'register.ts'), 'utf8'), refuserSource(10, probe.logFile))
})

test('the log lies beside the plugin folder, which the engine watches, and not in it', () => {
  const dir = tempDir()
  const probe = writeTimerRefuser(dir, 10)
  assert.equal(probe.logFile, join(dir, 'refused.log'))
  assert.ok(!probe.logFile.startsWith(`${probe.pluginDir}/`))
})

test('the module denies the delay it was made for and passes every other with next, so no other timer is dropped', () => {
  const source = refuserSource(10, '/tmp/a b/refused.log')
  assert.match(source, /on\('clock\.after'/)
  assert.match(source, /if \(e\.ms !== 10\) return next\(e\)/)
  assert.match(source, /return \{ deny: /)
  assert.ok(source.includes(JSON.stringify('/tmp/a b/refused.log')))
})

// Runs the module on a fake engine: the hook of `clock.after` with a `$` that records the log write.
async function run(ms: number, delays: number[]): Promise<{ answers: unknown[]; written: string[] }> {
  const dir = tempDir()
  const probe = writeTimerRefuser(dir, ms)
  const file = join(probe.pluginDir, 'hooks', 'register.ts')
  const { register } = (await import(`${file}?${Date.now()}-${Math.random()}`)) as {
    register: (on: (event: string, hook: (...args: never[]) => unknown) => void) => void
  }
  let hook: ((...args: unknown[]) => Promise<unknown>) | undefined
  register((event, h) => {
    if (event === 'clock.after') hook = h as (...args: unknown[]) => Promise<unknown>
  })
  assert.ok(hook, 'the module hears clock.after')
  const written: string[] = []
  const $ = { fs: { write: async (_path: string, text: string) => void written.push(text) } }
  const answers: unknown[] = []
  for (const delay of delays) answers.push(await hook($, { ms: delay }, async (e: unknown) => ({ passed: e })))
  return { answers, written }
}

test('run: the module denies its delay, counts each refusal in the log and passes the other delays', async () => {
  const { answers, written } = await run(10, [1000, 10, 1500, 10])
  assert.deepEqual(answers, [
    { passed: { ms: 1000 } },
    { deny: 'e2e timer refuser: clock.after of 10 ms' },
    { passed: { ms: 1500 } },
    { deny: 'e2e timer refuser: clock.after of 10 ms' },
  ])
  assert.deepEqual(written, ['1\n', '2\n'])
})

test('refusals reads the count of the log and is 0 while the log is missing, empty or not a number', () => {
  const dir = tempDir()
  const log = join(dir, 'refused.log')
  assert.equal(refusals(log), 0)
  writeFileSync(log, '')
  assert.equal(refusals(log), 0)
  writeFileSync(log, 'x\n')
  assert.equal(refusals(log), 0)
  writeFileSync(log, '3\n')
  assert.equal(refusals(log), 3)
})

test('a delay that is not a whole number of ms is refused when the probe is written', () => {
  assert.throws(() => writeTimerRefuser(tempDir(), 1.5), /whole number of ms/)
  assert.throws(() => writeTimerRefuser(tempDir(), -1), /whole number of ms/)
})

test('the probe remembers the delay it was made for', () => {
  assert.equal(writeTimerRefuser(tempDir(), 10).ms, 10)
  assert.equal(writeTimerRefuser(tempDir(), 0).ms, 0)
})

test('a second step with the same delay is no conflict, and one with another delay is refused with both delays named', () => {
  const probe = writeTimerRefuser(tempDir(), 10)
  assert.equal(timerRefuserRefusal(undefined, 10), undefined)
  assert.equal(timerRefuserRefusal(probe, 10), undefined)
  assert.equal(timerRefuserRefusal(probe, 20), 'timer refuser: already set to 10 ms, cannot also refuse 20 ms')
})

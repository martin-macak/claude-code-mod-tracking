import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { type Config, loadConfig, lockDirOf, outDirOf } from '../support/config.ts'
import { acquireLock, type Claimer, LockBusyError, makeClaimer } from '../support/lock.ts'

// Issue #185. world.ts claims a scenario with `lockDirOf(config)` and `outDirOf(config, scenario)`. These tests claim the same
// way, with a lock folder of their own: no test touches `$TMPDIR/cc-demo-lock`.
const made: string[] = []
const claimers: Claimer[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'private-run-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const claim of claimers) claim.leave()
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

// A run that does not wait: a busy lock fails at once, so a test sees the refusal and not a 30 minute wait.
const newRun = () => {
  const claim = makeClaimer({ waitMs: 0, onWait: () => {} })
  claimers.push(claim)
  return claim
}

// Claims the folder of a scenario as the world does.
const claimScenario = (claim: Claimer, config: Config, shared: string, out: string) =>
  claim(lockDirOf(config, shared), outDirOf(config, 'a-scenario', out))

const holder = (dir: string) => readFileSync(join(dir, '.lock'), 'utf8')

const privateRun = (socket: string) => loadConfig({ DEMO_SOCKET: socket, DEMO_DIR: `/tmp/cc-demo-${socket}` })

test('a run on the default socket takes the shared lock, and a second run on it is refused', async () => {
  const shared = join(tempDir(), 'lock')
  const out = tempDir()
  const config = loadConfig({})
  const release = await claimScenario(newRun(), config, shared, out)
  assert.equal(holder(shared), String(process.pid))
  await assert.rejects(claimScenario(newRun(), config, shared, out), LockBusyError)
  release()
  assert.equal(existsSync(join(shared, '.lock')), false)
})

test('a run that has a private socket but the default folder still takes the shared lock', async () => {
  const shared = join(tempDir(), 'lock')
  const release = await claimScenario(newRun(), loadConfig({ DEMO_SOCKET: 'lane-a' }), shared, tempDir())
  assert.equal(holder(shared), String(process.pid))
  release()
})

test('a run on a private socket and folder skips the shared lock, also while another run holds it', async () => {
  const shared = join(tempDir(), 'lock')
  const out = tempDir()
  const releaseShared = acquireLock(shared) // A default run is going on.
  try {
    // It does hold a second default run back.
    await assert.rejects(claimScenario(newRun(), loadConfig({}), shared, out), LockBusyError)
    const release = await claimScenario(newRun(), privateRun('lane-a'), shared, out)
    assert.equal(holder(shared), String(process.pid), 'the shared lock is still the default run')
    assert.equal(existsSync(join(shared, '.lock.queue')), false, 'the private run took no ticket in the shared queue')
    release()
  } finally {
    releaseShared()
  }
})

test('two runs on two private sockets hold their locks at the same time', async () => {
  const shared = join(tempDir(), 'lock')
  const out = tempDir()
  const [a, b] = [privateRun('lane-a'), privateRun('lane-b')]
  const releaseA = await claimScenario(newRun(), a, shared, out)
  const releaseB = await claimScenario(newRun(), b, shared, out)
  assert.equal(existsSync(join(shared, '.lock')), false)
  assert.equal(holder(lockDirOf(a, shared)), String(process.pid))
  assert.equal(holder(lockDirOf(b, shared)), String(process.pid))
  releaseA()
  releaseB()
})

test('two runs on one private socket exclude each other, and one scenario on two sockets has two output folders', async () => {
  const shared = join(tempDir(), 'lock')
  const out = tempDir()
  const config = privateRun('lane-a')
  const release = await claimScenario(newRun(), config, shared, out)
  // Same socket and same folder: the second run would kill the tmux server of the first.
  await assert.rejects(claimScenario(newRun(), config, shared, out), LockBusyError)
  release()
  assert.notEqual(outDirOf(privateRun('lane-a'), 'a-scenario', out), outDirOf(privateRun('lane-b'), 'a-scenario', out))
})

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { claimBudgetMs, claimScenario as claimScenarioIn } from '../support/claim-scenario.ts'
import { type Config, loadConfig, lockDirsOf, outDirOf } from '../support/config.ts'
import { acquireLock, type Claimer, LockBusyError, makeClaimer } from '../support/lock.ts'

// Issue #185. world.ts claims a scenario with `lockDirsOf(config)` and `outDirOf(config, scenario)`. These tests claim the same
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
const claimScenario = async (claim: Claimer, config: Config, shared: string, out: string) =>
  (await claimScenarioIn(claim, config, 'a-scenario', { lock: shared, out })).release

const holder = (dir: string) => readFileSync(join(dir, '.lock'), 'utf8')

const privateRun = (socket: string) => loadConfig({ DEMO_SOCKET: socket, DEMO_DIR: '/tmp/private-run-test' })

// world.ts claims through `claimScenario` and starts tmux on the socket of the config. A test of the helpers alone would pass
// if world.ts went back to the shared lock or to the fixed socket, so these pin the source (like lock-queue.test.ts does).
const worldSource = readFileSync(new URL('../support/world.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')

test('support/world.ts takes the socket, the lock and the run folder from the config', () => {
  assert.match(worldSource, /new Tmux\(this\.config\.socket\)/)
  assert.match(worldSource, /claimScenario\(claimRun, this\.config,/)
  assert.doesNotMatch(worldSource, /LOCK_DIR|OUT_DIR|new Tmux\('/)
})

test('the hook budget covers one wait for each lock the scenario takes', () => {
  const wait = 1000
  assert.equal(claimBudgetMs(loadConfig({}), wait), wait)
  assert.equal(claimBudgetMs(privateRun('lane-a'), wait), wait)
  assert.equal(claimBudgetMs(loadConfig({ DEMO_SOCKET: 'lane-a' }), wait), 2 * wait)
})

test('support/world.ts sizes the Before hook with claimBudgetMs', () => {
  assert.match(worldSource, /Before\(\s*\{\s*timeout: claimBudgetMs\(/)
})

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

test('claimScenario returns the run folder of the scenario and empties it', async () => {
  const [shared, out] = [join(tempDir(), 'lock'), tempDir()]
  const claimed = await claimScenarioIn(newRun(), privateRun('lane-a'), 'a-scenario', { lock: shared, out })
  assert.equal(claimed.outDir, outDirOf(privateRun('lane-a'), 'a-scenario', out))
  assert.equal(existsSync(claimed.outDir), true)
  claimed.release()
  const plain = await claimScenarioIn(newRun(), loadConfig({}), 'a-scenario', { lock: shared, out })
  assert.equal(plain.outDir, join(out, 'a-scenario'))
  plain.release()
})

test('a run that has its own socket but the default folder takes the shared lock and the lock of its socket', async () => {
  const shared = join(tempDir(), 'lock')
  const config = loadConfig({ DEMO_SOCKET: 'lane-a' })
  const release = await claimScenario(newRun(), config, shared, tempDir())
  assert.equal(holder(shared), String(process.pid))
  assert.equal(holder(`${shared}-lane-a`), String(process.pid))
  release()
  assert.equal(existsSync(join(shared, '.lock')), false)
  assert.equal(existsSync(join(`${shared}-lane-a`, '.lock')), false)
})

test('a private run and a shared-lock run on one socket exclude each other, in both orders', async () => {
  const [shared, out] = [join(tempDir(), 'lock'), tempDir()]
  const priv = privateRun('lane-a')
  const sharedSock = [
    loadConfig({ DEMO_SOCKET: 'lane-a' }), // default folder
    loadConfig({ DEMO_SOCKET: 'lane-a', DEMO_DIR: '/tmp/private-run-test', DEMO_RECORD: '1' }), // recording
  ]
  for (const other of sharedSock) {
    const releasePriv = await claimScenario(newRun(), priv, shared, out)
    await assert.rejects(claimScenario(newRun(), other, shared, out), LockBusyError)
    assert.equal(existsSync(join(shared, '.lock')), false, 'a refused claim gives the shared lock back')
    releasePriv()
    const releaseOther = await claimScenario(newRun(), other, shared, out)
    await assert.rejects(claimScenario(newRun(), priv, shared, out), LockBusyError)
    releaseOther()
  }
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
  assert.equal(holder(lockDirsOf(a, shared)[0] as string), String(process.pid))
  assert.equal(holder(lockDirsOf(b, shared)[0] as string), String(process.pid))
  releaseA()
  releaseB()
})

test('two runs on two sockets with one DEMO_DIR get two clone folders and two locks', async () => {
  const [shared, out] = [join(tempDir(), 'lock'), tempDir()]
  const [a, b] = ['lane-a', 'lane-b'].map(privateRun) as [Config, Config]
  assert.notEqual(a.dir, b.dir)
  const [releaseA, releaseB] = [
    await claimScenario(newRun(), a, shared, out),
    await claimScenario(newRun(), b, shared, out),
  ]
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

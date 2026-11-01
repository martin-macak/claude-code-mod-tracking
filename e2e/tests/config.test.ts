import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { test } from 'node:test'
import { isPrivateRun, loadConfig, lockDirsOf, outDirOf } from '../support/config.ts'

test('loadConfig gives the spec defaults for an empty env', () => {
  assert.deepEqual(loadConfig({}), {
    record: false,
    model: 'haiku',
    socket: 'cc-demo',
    dir: '/tmp/cc-demo',
    cols: 120,
    rows: 36,
    typeDelayMs: 35,
    turnTimeoutMs: 120_000,
    screenTimeoutMs: 20_000,
    lockWaitMs: 1_800_000,
    keep: false,
  })
})

test('loadConfig reads overrides', () => {
  const config = loadConfig({
    DEMO_RECORD: '1',
    DEMO_MODEL: 'sonnet',
    DEMO_DIR: '/tmp/x y',
    DEMO_COLS: '140',
    DEMO_TURN_TIMEOUT_S: '30',
    DEMO_KEEP: '1',
  })
  assert.equal(config.record, true)
  assert.equal(config.model, 'sonnet')
  assert.equal(config.dir, '/tmp/x y')
  assert.equal(config.cols, 140)
  assert.equal(config.turnTimeoutMs, 30_000)
  assert.equal(config.keep, true)
})

test('loadConfig rejects a value that is not a positive integer', () => {
  assert.throws(() => loadConfig({ DEMO_COLS: 'wide' }), /DEMO_COLS must be a positive integer, got "wide"/)
  assert.throws(() => loadConfig({ DEMO_ROWS: '0' }), /DEMO_ROWS/)
})

test('loadConfig reads the lock wait in seconds, and 0 means do not wait', () => {
  assert.equal(loadConfig({ DEMO_LOCK_WAIT_S: '90' }).lockWaitMs, 90_000)
  assert.equal(loadConfig({ DEMO_LOCK_WAIT_S: '0' }).lockWaitMs, 0)
  assert.equal(loadConfig({ DEMO_LOCK_WAIT_S: '' }).lockWaitMs, 1_800_000)
})

test('loadConfig rejects a lock wait that is not a whole number of seconds from 0', () => {
  assert.throws(
    () => loadConfig({ DEMO_LOCK_WAIT_S: '-1' }),
    /DEMO_LOCK_WAIT_S must be a non-negative integer, got "-1"/,
  )
  assert.throws(() => loadConfig({ DEMO_LOCK_WAIT_S: '1.5' }), /DEMO_LOCK_WAIT_S/)
  assert.throws(() => loadConfig({ DEMO_LOCK_WAIT_S: 'soon' }), /DEMO_LOCK_WAIT_S/)
})

test('loadConfig reads the tmux socket name, and an empty value keeps the default', () => {
  assert.equal(loadConfig({ DEMO_SOCKET: 'lane-7.h' }).socket, 'lane-7.h')
  assert.equal(loadConfig({ DEMO_SOCKET: 'a'.repeat(64) }).socket, 'a'.repeat(64))
  assert.equal(loadConfig({ DEMO_SOCKET: '' }).socket, 'cc-demo')
})

test('loadConfig rejects a socket name that is not one plain file name', () => {
  // The name is a file in the tmux folder and a folder of e2e/out, so a path or a dot name would escape both.
  for (const name of ['a/b', '../x', '.hidden', '..', 'two words', '-L', 'a'.repeat(65)]) {
    assert.throws(() => loadConfig({ DEMO_SOCKET: name }), /DEMO_SOCKET must be a socket name/, name)
  }
})

// Issue #185. A run is private when it has its own socket and its own folder: nothing in it is shared with another run.
const own = { DEMO_SOCKET: 'lane-a', DEMO_DIR: '/tmp/cc-demo-lane-a' }

test('a run is private only with its own socket and its own folder', () => {
  assert.equal(isPrivateRun(loadConfig({})), false)
  assert.equal(isPrivateRun(loadConfig(own)), true)
  // One of the two is not enough: the other one is still shared with every run that has the default.
  assert.equal(isPrivateRun(loadConfig({ DEMO_SOCKET: 'lane-a' })), false)
  assert.equal(isPrivateRun(loadConfig({ DEMO_DIR: '/tmp/cc-demo-lane-a' })), false)
  // Naming the defaults is the default.
  assert.equal(isPrivateRun(loadConfig({ DEMO_SOCKET: 'cc-demo', DEMO_DIR: '/tmp/cc-demo-lane-a' })), false)
  assert.equal(isPrivateRun(loadConfig({ DEMO_SOCKET: 'lane-a', DEMO_DIR: '/tmp/cc-demo' })), false)
})

test('a spelling of the default folder is the default folder, so it is no private folder', () => {
  // A trailing slash or a dot segment names the folder that every default run uses. A string compare would take it for another.
  for (const dir of ['/tmp/cc-demo/', '/tmp//cc-demo', '/tmp/other/../cc-demo', '/tmp/./cc-demo/']) {
    const config = loadConfig({ DEMO_SOCKET: 'lane-a', DEMO_DIR: dir })
    assert.equal(config.dir, '/tmp/cc-demo', dir)
    assert.equal(isPrivateRun(config), false, dir)
  }
})

test('a case variant of the default socket or folder is the default: a Mac reaches one server and one folder by both', () => {
  assert.equal(isPrivateRun(loadConfig({ DEMO_SOCKET: 'CC-DEMO', DEMO_DIR: '/tmp/x' })), false)
  assert.equal(isPrivateRun(loadConfig({ DEMO_SOCKET: 'lane-a', DEMO_DIR: '/tmp/CC-demo' })), false)
})

test('a folder inside the default folder is no private folder, and a relative folder is made absolute', () => {
  const inside = loadConfig({ DEMO_SOCKET: 'lane-a', DEMO_DIR: '/tmp/cc-demo/sub' })
  assert.equal(isPrivateRun(inside), false)
  assert.equal(inside.dir, '/tmp/cc-demo/sub')
  assert.equal(isAbsolute(loadConfig({ DEMO_SOCKET: 'lane-a', DEMO_DIR: 'rel' }).dir), true)
})

test('the clone of a private run is a folder of its socket, so two sockets with one DEMO_DIR get two clones', () => {
  const [a, b] = ['lane-a', 'lane-b'].map(socket => loadConfig({ DEMO_SOCKET: socket, DEMO_DIR: '/tmp/x' }))
  assert.equal(a?.dir, '/tmp/x/lane-a')
  assert.equal(b?.dir, '/tmp/x/lane-b')
  // A run that is not private keeps the folder as given.
  assert.equal(loadConfig({ DEMO_SOCKET: 'lane-a' }).dir, '/tmp/cc-demo')
  assert.equal(loadConfig({ DEMO_SOCKET: 'lane-a', DEMO_DIR: '/tmp/x', DEMO_RECORD: '1' }).dir, '/tmp/x')
})

test('a recording is never private: it writes e2e/out/demo, which make demo renders', () => {
  assert.equal(isPrivateRun(loadConfig({ ...own, DEMO_RECORD: '1' })), false)
})

test('the lock folders are the shared one, the one of the socket, or both for a socket that is not private', () => {
  assert.deepEqual(lockDirsOf(loadConfig({}), '/t/lock'), ['/t/lock'])
  assert.deepEqual(lockDirsOf(loadConfig({ DEMO_SOCKET: 'lane-a' }), '/t/lock'), ['/t/lock', '/t/lock-lane-a'])
  assert.deepEqual(lockDirsOf(loadConfig({ ...own, DEMO_RECORD: '1' }), '/t/lock'), ['/t/lock', '/t/lock-lane-a'])
  assert.deepEqual(lockDirsOf(loadConfig(own), '/t/lock'), ['/t/lock-lane-a'])
  assert.deepEqual(lockDirsOf(loadConfig({ ...own, DEMO_SOCKET: 'lane-b' }), '/t/lock'), ['/t/lock-lane-b'])
})

test('the output folder of a scenario is under private/<socket> for a private run only', () => {
  assert.equal(outDirOf(loadConfig({}), 'a-scenario', '/t/out'), '/t/out/a-scenario')
  assert.equal(outDirOf(loadConfig(own), 'a-scenario', '/t/out'), '/t/out/private/lane-a/a-scenario')
  assert.equal(outDirOf(loadConfig({ ...own, DEMO_RECORD: '1' }), 'demo', '/t/out'), '/t/out/demo')
})

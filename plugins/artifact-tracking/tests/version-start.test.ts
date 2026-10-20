// The version at the start of a load: the manifest is read once, the version is kept for `/track version` and the help
// view, and one debug line names it. A manifest that cannot be read gives "unknown" and the start goes on. Pure over
// fakePorts, which keeps the `version:` line in `versionLogs`. The kit tests of the same criteria, through the engine,
// are in version-wiring.test.tsx. Issue #65.
import { expect, test } from 'claude-code/testing'
import { managerWorld } from './fixtures/manager'
import { fakePorts, MANIFEST_FILE } from './fixtures/ports'

const MANIFEST = '{"name":"artifact-tracking","version":"1.2.3"}'

test('the first start reads the manifest once, keeps the version and logs one line that names it', async () => {
  const t = managerWorld({ fake: { files: { [MANIFEST_FILE]: MANIFEST } } })
  expect(t.m.version).toBeUndefined() // nothing is read before the first start: no value, not `unknown`
  await t.m.start(t.w.ports, { fromSessionStart: true, cwd: '/work' })
  expect(t.m.version).toBe('1.2.3')
  expect(t.w.versionLogs).toEqual(['version: 1.2.3'])
  expect(t.w.reads.filter(p => p === MANIFEST_FILE)).toEqual([MANIFEST_FILE])
})

test('a lazy start and then session.start read once and log once', async () => {
  const t = managerWorld({ fake: { files: { [MANIFEST_FILE]: MANIFEST } } })
  await t.m.entry(t.w.ports) // a hook that came before session.start: the lazy start
  await t.m.start(t.w.ports, { fromSessionStart: true, cwd: '/work' }) // runs the sequence again, with the cwd
  await t.m.entry(t.w.ports)
  expect(t.w.reads.filter(p => p === MANIFEST_FILE)).toHaveLength(1)
  expect(t.w.versionLogs).toEqual(['version: 1.2.3'])
})

test('a manifest that cannot be read logs unknown with the reason and the start goes on', async () => {
  const t = managerWorld() // no manifest on the fake disk
  await t.m.start(t.w.ports, { fromSessionStart: true, cwd: '/work' })
  expect(t.m.version).toBe('unknown')
  expect(t.w.versionLogs).toHaveLength(1)
  expect(t.w.versionLogs[0]).toMatch(/^version: unknown \(cannot read the manifest: ENOENT/)
  expect(t.m.items.ready).toBe(true) // the mod works as before
})

test('a manifest with no version string logs unknown with the reason', async () => {
  const t = managerWorld({ fake: { files: { [MANIFEST_FILE]: '{"name":"artifact-tracking"}' } } })
  await t.m.start(t.w.ports, { fromSessionStart: true, cwd: '/work' })
  expect(t.m.version).toBe('unknown')
  expect(t.w.versionLogs).toEqual(['version: unknown (the manifest has no version string)'])
})

test('a plugin root the engine refuses gives unknown and does not stop the start', async () => {
  const t = managerWorld({ fake: { files: { [MANIFEST_FILE]: MANIFEST } } })
  const refused = {
    ...t.w.ports,
    plugin: {
      get root(): string {
        throw new Error('no plugin')
      },
    },
  }
  await t.m.start(refused, { fromSessionStart: true, cwd: '/work' })
  expect(t.m.version).toBe('unknown')
  expect(t.w.versionLogs).toEqual(['version: unknown (cannot read the manifest: no plugin)'])
  expect(t.m.items.ready).toBe(true)
})

test('a new load reads the manifest again: a manager is one load', async () => {
  const files = { [MANIFEST_FILE]: MANIFEST }
  const first = managerWorld({ fake: { files } })
  await first.m.start(first.w.ports, { fromSessionStart: true, cwd: '/work' })
  const second = managerWorld({ fake: { files: { [MANIFEST_FILE]: '{"version":"2.0.0"}' } } })
  await second.m.start(second.w.ports, { fromSessionStart: true, cwd: '/work' })
  expect([first.m.version, second.m.version]).toEqual(['1.2.3', '2.0.0'])
})

test('the fake keeps only the version line of the start apart, and any other line that begins with version: stays in logs', () => {
  const w = fakePorts()
  w.ports.log('version: 1.2.3')
  w.ports.log('version: unknown (the manifest has no version string)')
  w.ports.log('version: 1 is not a whole number, using the default')
  expect(w.versionLogs).toEqual(['version: 1.2.3', 'version: unknown (the manifest has no version string)'])
  expect(w.logs).toEqual(['version: 1 is not a whole number, using the default'])
})

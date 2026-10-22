// Kit tests of the version of the mod (issue #65), one group per acceptance criterion: `/track version`, the help view,
// the debug log line at the start, and a manifest that cannot be read. The kit cannot read the real disk, so `world`
// answers `$.fs.read` of `<plugin root>/.claude-plugin/plugin.json` itself. That the real engine reads the real file is
// shown by the headless spike in the PR (`claude -p "/track version"` over this folder). pure checks of the read are in
// manifest.test.ts and version-start.test.ts.
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { mountPane } from './fixtures/pane'
import { MANIFEST_TAIL, quiet, response, START, track, world } from './fixtures/world'

const MANIFEST = JSON.stringify({ name: 'artifact-tracking', version: '1.2.3', description: 'x' })
const text = async ($: Engine, args: string) => (await track($, args)).text ?? ''
type World = ReturnType<typeof world>
const manifestReads = (w: World) => w.fake.fsCalls.filter(c => c.startsWith('read ') && c.endsWith(MANIFEST_TAIL))
const versionLogs = (w: World) => w.fake.logs.filter(l => l.text.startsWith('version:'))

// ---------------------------------------------------------------- AC 1: /track version prints the version

test('/track version prints the version from plugin.json', async ($, on) => {
  world(on, { manifest: MANIFEST })
  await $.session.start(START)
  expect(await text($, 'version')).toBe('artifact-tracking 1.2.3')
  expect(await text($, ' VERSION ')).toBe('artifact-tracking 1.2.3')
})

test('/track version reads the manifest from an absolute path under the plugin folder, once per load', async ($, on) => {
  const w = world(on, { manifest: MANIFEST })
  await $.session.start(START)
  await text($, 'version')
  await text($, 'version')
  const reads = manifestReads(w)
  expect(reads).toHaveLength(1)
  expect(reads[0]?.slice('read '.length).startsWith('/')).toBe(true)
})

test('/track version needs no session.start: the entry of the command starts the mod and reads the manifest', async ($, on) => {
  world(on, { manifest: MANIFEST })
  expect(await text($, 'version')).toBe('artifact-tracking 1.2.3')
})

test('the usage line and the argument hint name version', async ($, on) => {
  const w = world(on, { manifest: MANIFEST })
  await $.session.start(START)
  expect(w.registered.at(-1)?.argumentHint).toBe(
    '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>]',
  )
  expect(await text($, 'bogus')).toContain(
    'help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio',
  )
})

// ---------------------------------------------------------------- AC 2: the help view shows the version

test('/track help prints the version after the config file line', async ($, on) => {
  world(on, { manifest: MANIFEST })
  const lines = (await text($, 'help')).split('\n')
  const at = lines.findIndex(l => l.startsWith('Config file:'))
  expect(at).toBeGreaterThan(-1)
  expect(lines[at + 1]).toBe('Version: 1.2.3')
})

test('the help view of the pane (key h) draws the version, and h again returns to the rows', async ($, on) => {
  world(on, { manifest: MANIFEST })
  await track($) // the pane opens from /track, after the start
  const ui = await mountPane($)
  await ui.press({ key: 'help' })
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'Version: 1.2.3')).toBe(true)
  await ui.press({ key: 'help' })
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text?.startsWith('Version:'))).toBe(false)
  await ui.unmount()
})

// ---------------------------------------------------------------- AC 3: one debug log line at the start

test('session.start writes one debug log line that names the version, and no other line comes before it', async ($, on) => {
  const w = world(on, { manifest: MANIFEST })
  await $.session.start(START)
  expect(w.fake.logs[0]).toEqual({ text: 'version: 1.2.3', to: 'debug' })
  expect(versionLogs(w)).toHaveLength(1)
})

test('later hooks and commands add no second version line', async ($, on) => {
  const w = world(on, { manifest: MANIFEST })
  await $.session.start(START)
  await text($, 'version')
  await text($, 'help')
  await $.session.append(response('See https://one.example/'))
  await quiet(w.calls)
  expect(versionLogs(w)).toHaveLength(1)
})

test('a hook that comes before session.start starts the mod and the line still comes once', async ($, on) => {
  const w = world(on, { manifest: MANIFEST })
  await text($, 'version') // the lazy start
  await $.session.start(START)
  expect(versionLogs(w).map(l => l.text)).toEqual(['version: 1.2.3'])
})

// ---------------------------------------------------------------- AC 4: an unreadable manifest shows unknown

test('a missing manifest shows unknown in /track version, in the help view and in the log, with the reason', async ($, on) => {
  const w = world(on) // no manifest: the stub answers ENOENT
  await $.session.start(START)
  expect(await text($, 'version')).toBe('artifact-tracking unknown')
  expect(await text($, 'help')).toContain('\nVersion: unknown')
  expect(versionLogs(w)).toHaveLength(1)
  expect(versionLogs(w)[0]?.text).toMatch(/^version: unknown \(cannot read the manifest: .*ENOENT/)
})

test('a manifest the engine refuses to read shows unknown', async ($, on) => {
  const w = world(on, { manifest: MANIFEST, denyFs: { read: 'EACCES: permission denied' } })
  await $.session.start(START)
  expect(await text($, 'version')).toBe('artifact-tracking unknown')
  expect(versionLogs(w)[0]?.text).toContain('EACCES')
})

for (const [what, manifest] of [
  ['is not JSON', '{ not json'],
  ['has no version', '{"name":"artifact-tracking"}'],
  ['has a version that is not a string', '{"version":7}'],
] as const)
  test(`a manifest that ${what} shows unknown`, async ($, on) => {
    const w = world(on, { manifest })
    await $.session.start(START)
    expect(await text($, 'version')).toBe('artifact-tracking unknown')
    expect(versionLogs(w)).toHaveLength(1)
  })

test('with no readable manifest the mod works as before: it captures a link, lists it and opens the pane', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.append(response('See https://one.example/'))
  await w.clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(w.calls)
  expect(await text($, '')).toContain('one.example')
  expect(w.opened).toHaveLength(1)
  expect(await text($, 'help')).toContain('Pane keys')
})

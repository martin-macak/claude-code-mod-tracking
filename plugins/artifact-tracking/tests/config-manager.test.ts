// The ConfigManager over an in-memory ConfigFs: the path rule, a missing or invalid file, torn reads, the signature
// cache, the first-run write, the missing-key merge, a read-only newer file and a migration. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 4 (decisions C7, C10, C16, C17).
import { expect, test } from 'claude-code/testing'
import type { DocSpec } from '../core/infra/config-file'
import { ConfigManager, MIGRATIONS } from '../core/infra/config-manager'
import type { ConfigFs, Migration } from '../core/interfaces/config'
import type { JsonObject } from '../core/interfaces/items'
import type { EnvName } from '../core/interfaces/ports'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { GITHUB_DEFAULTS, githubConfig } from '../trackers/github/config'
import { WEB_DEFAULTS, webConfig } from '../trackers/web/config'
import { fakeConfigFs } from './fixtures/config-fs'

const P = '/h/.config/claude-code/mods/tracker/config.json'
const SPECS: readonly DocSpec[] = [
  { id: 'github', config: githubConfig },
  { id: 'web', config: webConfig },
]
const STORED: ReadonlyMap<string, JsonObject> = new Map<string, JsonObject>([
  ['github', GITHUB_DEFAULTS],
  ['web', WEB_DEFAULTS],
])

type Env = Partial<Record<EnvName, string>>

function make(
  o: { files?: Record<string, string>; env?: Env; version?: number; migrations?: readonly Migration[] } = {},
) {
  const fake = fakeConfigFs(o.files)
  const log: string[] = []
  const env = o.env ?? { HOME: '/h' }
  const manager = new ConfigManager({
    fs: fake.fs,
    env: { get: async (name: EnvName) => env[name] },
    specs: SPECS,
    log: line => void log.push(line),
    version: o.version,
    migrations: o.migrations,
  })
  return { fake, log, manager }
}

interface FileDoc {
  version?: unknown
  moved?: unknown
  legacy?: unknown
  global?: JsonObject
  trackers: Record<string, JsonObject | undefined>
}
const parsed = (text: string | undefined): FileDoc => JSON.parse(text ?? 'null') as FileDoc
/** An env with `HOME` only. */
const homeEnv = { get: async (name: EnvName): Promise<string | undefined> => (name === 'HOME' ? '/h' : undefined) }
const writesTo = (calls: readonly string[]): string[] => calls.filter(c => c.startsWith('write '))
const UP_TO_2: Migration = { from: 1, to: 2, up: r => ({ ...r, version: 2, moved: true }) }

/** The text a first run writes, from a fresh manager. */
async function firstRunText(): Promise<string> {
  const { fake, manager } = make()
  await manager.reconcile(STORED)
  return fake.files.get(P) ?? ''
}

test('MIGRATIONS is empty: version 1 has no migration', () => {
  expect(MIGRATIONS).toEqual([])
})

test('no HOME and no override: defaults, no fs call, no problem', async () => {
  const { fake, manager } = make({ env: {} })
  expect(await manager.refresh()).toBe(false)
  await manager.reconcile(new Map())
  expect(fake.calls).toEqual([])
  expect(manager.problems()).toEqual([])
  expect(manager.path()).toBeUndefined()
  expect(manager.global()).toEqual(GLOBAL_DEFAULTS)
})

test('before the first refresh every view is the defaults', () => {
  const { manager } = make()
  expect(manager.global()).toEqual(GLOBAL_DEFAULTS)
  expect(manager.slice('github')).toEqual(GITHUB_DEFAULTS)
  expect(manager.enabled('web')).toBe(true)
  expect(manager.problems()).toEqual([])
  expect(manager.path()).toBeUndefined()
})

test('a missing file reads the defaults; reconcile writes the defaults and the store results once', async () => {
  const { fake, manager } = make()
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(1)
  expect(fake.writes[0]?.path).toBe(P)
  const text = fake.writes[0]?.text ?? ''
  expect(parsed(text)).toEqual({
    version: 1,
    global: GLOBAL_DEFAULTS,
    trackers: { github: GITHUB_DEFAULTS, web: WEB_DEFAULTS },
  })
  expect(text.startsWith('{\n  "version": 1,\n  "global": {\n    "refresh": {\n      "tickMs": 30000,')).toBe(true)
  expect(text.endsWith('}\n')).toBe(true)
  expect(manager.problems()).toEqual([])
  expect(manager.path()).toBe(P)
})

test('a second reconcile in the same load writes nothing', async () => {
  const { fake, manager } = make()
  await manager.reconcile(STORED)
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(1)
})

test('the refresh after our own write reports no change', async () => {
  const { fake, manager } = make()
  await manager.reconcile(STORED)
  const reads = fake.reads
  expect(await manager.refresh()).toBe(false)
  expect(fake.reads).toBe(reads)
})

test('a complete file is not written', async () => {
  const { fake, manager } = make({ files: { [P]: await firstRunText() } })
  await manager.refresh()
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
})

test('a complete file is never rewritten for its layout: indent, final newline, key order', async () => {
  const text = await firstRunText()
  const doc = JSON.parse(text) as JsonObject
  const layouts: Record<string, string> = {
    'a four-space indent': `${JSON.stringify(doc, null, 4)}\n`,
    'no final newline': text.trimEnd(),
    'one line': JSON.stringify(doc),
    'the top-level keys in another order': `${JSON.stringify({ trackers: doc.trackers, global: doc.global, version: doc.version }, null, 2)}\n`,
  }
  for (const [name, layout] of Object.entries(layouts)) {
    const { fake, manager } = make({ files: { [P]: layout } })
    await manager.refresh()
    await manager.reconcile(STORED)
    expect([name, fake.writes]).toEqual([name, []])
    expect([name, fake.files.get(P)]).toEqual([name, layout])
  }
})

test('a file that lacks a key is written once, with version, global and trackers first and the other keys in order', async () => {
  const { fake, manager } = make({ files: { [P]: '{"zeta":1,"trackers":{"web":{"enabled":false}},"alpha":2}' } })
  await manager.refresh()
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(1)
  const file = parsed(fake.files.get(P))
  expect(Object.keys(file)).toEqual(['version', 'global', 'trackers', 'zeta', 'alpha'])
  expect(file.trackers.web).toEqual({ enabled: false, prompt: { enabled: false, maxItems: 20 } })
})

test('a migrated file is written even when no key is missing', async () => {
  const complete = `${JSON.stringify({ ...JSON.parse(await firstRunText()), moved: true }, null, 4)}\n`
  const { fake, manager } = make({ files: { [P]: complete }, version: 2, migrations: [UP_TO_2] })
  await manager.refresh()
  await manager.reconcile(STORED)
  expect(fake.writes.map(w => w.path)).toEqual([`${P}.v1.bak`, P])
  expect(parsed(fake.files.get(P)).version).toBe(2)
})

test('reconcile makes no fs call for a file that failed to parse', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  await manager.refresh()
  fake.edit(P, '{ nope')
  await manager.refresh() // the failed signature is the one on disk, and the snapshot is the older good read
  expect(manager.problems()).toHaveLength(1)
  const before = fake.calls.length
  await manager.reconcile(STORED)
  expect(fake.calls.slice(before)).toEqual([]) // the known-bad file stops the write before any stat
  expect(fake.writes).toHaveLength(0)
})

test('a partial file gains version first, global and the missing tracker; user values stay', async () => {
  const { fake, manager } = make({ files: { [P]: '{"trackers":{"web":{"enabled":false}}}' } })
  await manager.refresh()
  await manager.reconcile(STORED)
  const file = parsed(fake.files.get(P))
  expect(Object.keys(file)).toEqual(['version', 'global', 'trackers'])
  expect(file.trackers.web).toEqual({ enabled: false, prompt: { enabled: false, maxItems: 20 } })
  expect(file.trackers.github).toEqual(GITHUB_DEFAULTS)
  expect(Object.keys(file.trackers)).toEqual(['web', 'github'])
  expect(manager.enabled('web')).toBe(false)
  expect(fake.writes).toHaveLength(1)
})

test('a store result is written only for a tracker that has one', async () => {
  const { fake, manager } = make()
  await manager.reconcile(new Map<string, JsonObject>([['web', WEB_DEFAULTS]]))
  expect(parsed(fake.files.get(P)).trackers).toEqual({ web: WEB_DEFAULTS })
})

test('an equal signature is not read again; a changed one is', async () => {
  const text = '{"version":1}'
  const { fake, manager } = make({ files: { [P]: text } })
  await manager.refresh()
  await manager.refresh()
  expect(fake.reads).toBe(1)
  fake.edit(P, text)
  expect(await manager.refresh()).toBe(false)
  expect(fake.reads).toBe(2)
  fake.edit(P, '{"global":{"refresh":{"tickMs":60000}}}')
  expect(await manager.refresh()).toBe(true)
  expect(manager.global().refresh.tickMs).toBe(60000)
})

test('refresh returns true when only the problems changed', async () => {
  const { fake, manager } = make({ files: { [P]: '{"trackers":{"github":{"chunksize":10}}}' } })
  await manager.refresh()
  expect(manager.problems()).toEqual(['trackers.github.chunksize: unknown key. The mod keeps it and ignores it.'])
  fake.edit(P, '{"trackers":{"github":{}}}')
  expect(await manager.refresh()).toBe(true)
  expect(manager.problems()).toEqual([])
  // An unknown tracker id changes the problems and no view.
  fake.edit(P, '{"trackers":{"githb":{}}}')
  expect(await manager.refresh()).toBe(true)
  expect(manager.problems()).toHaveLength(1)
  fake.edit(P, '{}')
  expect(await manager.refresh()).toBe(true)
  expect(manager.problems()).toEqual([])
})

test('two refreshes at once read the file once', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  const [a, b] = await Promise.all([manager.refresh(), manager.refresh()])
  expect(a).toBe(b)
  expect(fake.reads).toBe(1)
  // The flight ends: a later refresh checks again.
  fake.edit(P, '{"global":{"refresh":{"tickMs":60000}}}')
  expect(await manager.refresh()).toBe(true)
})

test('a torn read keeps the last good values with no problem; the next check reads the new text', async () => {
  const { fake, manager } = make({ files: { [P]: '{"global":{"refresh":{"tickMs":40000}}}' } })
  await manager.refresh()
  expect(manager.global().refresh.tickMs).toBe(40000)
  fake.edit(P, '{"global":{"refresh":{"tickMs":50000}}}')
  fake.tearNext('{"glob')
  expect(await manager.refresh()).toBe(false)
  expect(manager.problems()).toEqual([])
  expect(manager.global().refresh.tickMs).toBe(40000)
  expect(await manager.refresh()).toBe(true)
  expect(manager.global().refresh.tickMs).toBe(50000)
})

test('a torn first read is no problem and is never written over', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  fake.tearNext('{"ver')
  await manager.reconcile(STORED)
  expect(manager.problems()).toEqual([])
  expect(fake.writes).toHaveLength(0)
})

test('a trailing comma is one problem and no write; the fixed file is read at the next check', async () => {
  const { fake, manager } = make({ files: { [P]: '{ "version": 1, }' } })
  await manager.refresh()
  expect(manager.problems()).toHaveLength(1)
  expect(manager.problems()[0]).toMatch(
    /^The file is not valid JSON: .+\. The mod keeps the last good values and does not change the file\.$/,
  )
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
  fake.edit(P, '{ "version": 1 }')
  await manager.refresh()
  expect(manager.problems()).toEqual([])
})

test('a persistent parse error is read twice, then not read again until the file changes', async () => {
  const { fake, manager } = make({ files: { [P]: '{ "version": 1, }' } })
  await manager.refresh()
  expect(fake.reads).toBe(2)
  await manager.refresh()
  expect(fake.reads).toBe(2)
  expect(manager.problems()).toHaveLength(1)
})

test('a parse error that mends on the second read is no problem', async () => {
  const bad = '{ "version": 1, }'
  const good = '{ "version": 1  }'
  const { fake } = make({ files: { [P]: bad } })
  const read = fake.fs.read.bind(fake.fs)
  let first = true
  const fs: ConfigFs = {
    ...fake.fs,
    read: async path => {
      const text = await read(path)
      // The writer finishes between our two reads: same size, same mtime.
      if (first) fake.files.set(path, good)
      first = false
      return text
    },
  }
  const m = new ConfigManager({ fs, env: homeEnv, specs: SPECS, log: () => {} })
  await m.refresh()
  expect(m.problems()).toEqual([])
  expect(fake.reads).toBe(2)
})

test('a root that is not an object is a problem and is never written', async () => {
  const { fake, manager } = make({ files: { [P]: '[1,2]' } })
  await manager.refresh()
  expect(manager.problems()).toEqual([
    'The file must hold one JSON object. The mod keeps the last good values and does not change the file.',
  ])
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
})

test('version 2 is read and never written', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":2,"global":{"refresh":{"tickMs":60000}}}' } })
  await manager.refresh()
  expect(manager.global().refresh.tickMs).toBe(60000)
  expect(manager.problems()).toEqual([
    'The file has version 2, and this mod knows version 1 only. The mod reads the file but does not change it.',
  ])
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
})

test('a write re-stats first and keeps an edit made after the last read', async () => {
  const { fake, manager } = make({ files: { [P]: '{"trackers":{"web":{"enabled":false}}}' } })
  await manager.refresh()
  fake.edit(P, '{"trackers":{"github":{"chunkSize":10}}}')
  await manager.reconcile(STORED)
  expect(parsed(fake.files.get(P)).trackers.github?.chunkSize).toBe(10)
  expect(manager.slice('github').chunkSize).toBe(10)
})

test('a save in flight when reconcile runs: the file is not written over', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  await manager.refresh()
  fake.edit(P, '{"global":{"refresh":{"tickMs":50000}}}')
  fake.tearNext('{"x')
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
  expect(manager.problems()).toEqual([])
  // The next check reads the finished save.
  expect(await manager.refresh()).toBe(true)
  expect(manager.global().refresh.tickMs).toBe(50000)
})

test('a file that broke after the last read is not written over', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  await manager.refresh()
  fake.edit(P, '{ nope')
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
  expect(manager.problems()).toHaveLength(1)
})

test('a refused first-run write is one problem and no second try', async () => {
  const { fake, manager } = make()
  fake.deny.write = 'EACCES: permission denied, open'
  await manager.reconcile(STORED)
  expect(manager.problems()).toEqual([
    'The mod cannot write the file: EACCES: permission denied, open. It tries again at the next start.',
  ])
  expect(manager.global()).toEqual(GLOBAL_DEFAULTS)
  // The user makes the file. A good read does not clear the line.
  fake.edit(P, '{ "version": 1 }')
  await manager.refresh()
  expect(manager.problems()).toHaveLength(1)
  await manager.reconcile(STORED)
  expect(writesTo(fake.calls)).toHaveLength(1)
})

test('a refusal of the engine is quoted without the plugin and the call it names', async () => {
  const wrapped = (op: string) => `artifact-tracking: $.fs.${op}: EACCES: permission denied`
  const write = make()
  write.fake.deny.write = wrapped('write')
  await write.manager.reconcile(STORED)
  expect(write.manager.problems()).toEqual([
    'The mod cannot write the file: EACCES: permission denied. It tries again at the next start.',
  ])
  const read = make({ files: { [P]: '{"version":1}' } })
  read.fake.deny.read = wrapped('read')
  await read.manager.refresh()
  expect(read.manager.problems()).toEqual([
    'The mod cannot read the file: EACCES: permission denied. It keeps the last good values.',
  ])
  const exists = make()
  exists.fake.deny.stat = 'x'
  exists.fake.deny.exists = wrapped('exists')
  await exists.manager.refresh()
  expect(exists.manager.problems()).toEqual([
    'The mod cannot check the file: EACCES: permission denied. It uses the defaults and does not write the file.',
  ])
  // Only the engine's own prefix goes. A message that merely has a colon keeps it.
  const plain = make()
  plain.fake.deny.write = 'EIO: i/o error, write'
  await plain.manager.reconcile(STORED)
  expect(plain.manager.problems()[0]).toContain('EIO: i/o error, write.')
})

test('a refused read is one problem', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  fake.deny.read = 'EACCES: permission denied'
  await manager.refresh()
  expect(manager.problems()).toEqual([
    'The mod cannot read the file: EACCES: permission denied. It keeps the last good values.',
  ])
  delete fake.deny.read
  await manager.refresh()
  expect(manager.problems()).toHaveLength(1)
  fake.edit(P, '{"version":1}')
  await manager.refresh()
  expect(manager.problems()).toEqual([])
})

test('the message of a refusal has no trailing period', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  fake.deny.read = 'EACCES.'
  await manager.refresh()
  expect(manager.problems()).toEqual(['The mod cannot read the file: EACCES. It keeps the last good values.'])
})

test('stat refused while the file exists: no write, one problem', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' } })
  fake.deny.stat = 'x'
  await manager.refresh()
  expect(manager.problems()).toEqual([
    'The mod cannot read the status of the file. It uses the defaults and does not write the file.',
  ])
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
  // The refusal is not sticky: when stat answers again the file is read.
  delete fake.deny.stat
  fake.edit(P, '{"global":{"refresh":{"tickMs":60000}}}')
  expect(await manager.refresh()).toBe(true)
  expect(manager.problems()).toEqual([])
  expect(manager.global().refresh.tickMs).toBe(60000)
})

test('exists refused: no write, one problem', async () => {
  const { fake, manager } = make()
  fake.deny.stat = 'x'
  fake.deny.exists = 'EPERM'
  await manager.refresh()
  expect(manager.problems()).toEqual([
    'The mod cannot check the file: EPERM. It uses the defaults and does not write the file.',
  ])
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(0)
})

test('a stat that rejects counts as a refusal', async () => {
  const fake = fakeConfigFs()
  const fs: ConfigFs = {
    ...fake.fs,
    stat: async () => {
      throw new Error('boom')
    },
  }
  const m = new ConfigManager({ fs, env: homeEnv, specs: SPECS, log: () => {} })
  await m.reconcile(STORED)
  expect(fake.writes).toHaveLength(1)
})

test('a deleted file brings back the defaults and is not written again in this load', async () => {
  const { fake, manager } = make({ files: { [P]: '{"global":{"refresh":{"tickMs":60000}}}' } })
  await manager.refresh()
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(1)
  expect(manager.global().refresh.tickMs).toBe(60000)
  fake.files.delete(P)
  expect(await manager.refresh()).toBe(true)
  expect(manager.global()).toEqual(GLOBAL_DEFAULTS)
  await manager.reconcile(STORED)
  expect(fake.writes).toHaveLength(1)
})

test('a migration writes config.json.v1.bak first, then the upgraded file', async () => {
  const old = '{"version":1}'
  const { fake, manager } = make({ files: { [P]: old }, version: 2, migrations: [UP_TO_2] })
  await manager.refresh()
  expect(manager.problems()).toEqual([])
  await manager.reconcile(STORED)
  expect(fake.writes.map(w => w.path)).toEqual([`${P}.v1.bak`, P])
  expect(fake.writes[0]?.text).toBe(old)
  const next = parsed(fake.writes[1]?.text)
  expect(next.version).toBe(2)
  expect(next.moved).toBe(true)
  expect(Object.keys(next)).toEqual(['version', 'global', 'trackers', 'moved'])
})

test('a migration works on a copy: the backup holds the text as read', async () => {
  const old = '{"version":1,"legacy":{"a":1}}'
  const up: Migration = {
    from: 1,
    to: 2,
    up: r => {
      ;(r.legacy as { a: number }).a = 99
      return { ...r, version: 2 }
    },
  }
  const { fake, manager } = make({ files: { [P]: old }, version: 2, migrations: [up] })
  await manager.reconcile(STORED)
  expect(fake.writes[0]?.text).toBe(old)
  expect(parsed(fake.files.get(P)).legacy).toEqual({ a: 99 })
})

test('a migration chain runs step by step; an up that forgets the version still ends at `to`', async () => {
  const steps: Migration[] = [
    { from: 1, to: 2, up: r => ({ ...r, a: 1 }) },
    { from: 2, to: 3, up: r => ({ ...r, b: 2 }) },
  ]
  const { fake, manager } = make({ files: { [P]: '{"version":1}' }, version: 3, migrations: steps })
  await manager.reconcile(STORED)
  const next = parsed(fake.files.get(P))
  expect(next).toMatchObject({ version: 3, a: 1, b: 2 })
  expect(fake.writes.map(w => w.path)).toEqual([`${P}.v1.bak`, P])
})

test('a refused backup stops the upgrade', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":1}' }, version: 2, migrations: [UP_TO_2] })
  fake.deny.write = 'ENOSPC: no space left on device'
  await manager.reconcile(STORED)
  expect(manager.problems()).toEqual([
    'The mod cannot save a copy of the file before the upgrade: ENOSPC: no space left on device. It does not change the file.',
  ])
  expect(writesTo(fake.calls)).toEqual([`write ${P}.v1.bak`])
  expect(fake.files.get(P)).toBe('{"version":1}')
})

test('an older file with no migration chain is read-only', async () => {
  const text = '{"version":1}'
  const { fake, manager } = make({ files: { [P]: text }, version: 2, migrations: [] })
  await manager.reconcile(STORED)
  expect(manager.problems()).toEqual([
    'The file has version 1, and this mod knows version 2 only. The mod reads the file but does not change it.',
  ])
  expect(fake.writes).toHaveLength(0)
})

test('a chain that stops short, or an up that throws, leaves the file read-only', async () => {
  const short = make({ files: { [P]: '{"version":1}' }, version: 3, migrations: [UP_TO_2] })
  await short.manager.reconcile(STORED)
  expect(short.fake.writes).toHaveLength(0)
  expect(short.manager.problems()).toHaveLength(1)
  const broken: Migration = {
    from: 1,
    to: 2,
    up: () => {
      throw new Error('bug')
    },
  }
  const thrown = make({ files: { [P]: '{"version":1}' }, version: 2, migrations: [broken] })
  await thrown.manager.reconcile(STORED)
  expect(thrown.fake.writes).toHaveLength(0)
  expect(thrown.manager.problems()).toHaveLength(1)
})

test('a version that is not a whole number is read as 1 and the file is still completed', async () => {
  const { fake, manager } = make({ files: { [P]: '{"version":"1"}' } })
  await manager.refresh()
  expect(manager.problems()).toEqual([
    'version: "1" is not a whole number of 1 or more. The mod reads the file as version 1.',
  ])
  await manager.reconcile(STORED)
  expect(parsed(fake.files.get(P)).version).toBe('1')
})

test('the views are frozen; enabled reads enabled', async () => {
  const { manager } = make({ files: { [P]: '{"trackers":{"web":{"enabled":false}}}' } })
  await manager.refresh()
  expect(Object.isFrozen(manager.slice('github'))).toBe(true)
  expect(Object.isFrozen(manager.global().tools.breaker)).toBe(true)
  expect(manager.slice('nope')).toEqual({})
  expect(Object.isFrozen(manager.slice('nope'))).toBe(true)
  expect(manager.enabled('nope')).toBe(true)
  expect(manager.enabled('web')).toBe(false)
  expect(manager.enabled('github')).toBe(true)
})

test('a relative override is a problem and the HOME path is used', async () => {
  const { manager } = make({ env: { CLAUDE_TRACKER_CONFIG_DIR: 'rel', HOME: '/h' } })
  await manager.refresh()
  expect(manager.path()).toBe(P)
  expect(manager.problems()).toEqual(['CLAUDE_TRACKER_CONFIG_DIR is not an absolute path: "rel". The mod ignores it.'])
})

test('the override names the whole folder', async () => {
  const { fake, manager } = make({ env: { CLAUDE_TRACKER_CONFIG_DIR: '/t/cfg', HOME: '/h' } })
  await manager.reconcile(STORED)
  expect(fake.writes.map(w => w.path)).toEqual(['/t/cfg/config.json'])
})

test('problems come in the order of the Copy table, with a refused write before the values (issue #144)', async () => {
  const { fake, manager } = make({
    env: { CLAUDE_TRACKER_CONFIG_DIR: 'rel', HOME: '/h' },
    files: { [P]: '{"version":"x","global":{"refresh":{"tickMs":"a"}},"trackers":{"github":{"chunkSize":0},"zz":{}}}' },
  })
  fake.deny.write = 'EROFS'
  await manager.reconcile(STORED)
  const texts = manager.problems().map(p => p.split(':')[0])
  expect(texts).toEqual([
    'CLAUDE_TRACKER_CONFIG_DIR is not an absolute path',
    'The mod cannot write the file',
    'version',
    'global.refresh.tickMs',
    'trackers.github.chunkSize',
    'trackers.zz',
  ])
})

test('each problem is logged once', async () => {
  const { fake, log, manager } = make({ files: { [P]: '{ "version": 1, }' } })
  await manager.refresh()
  await manager.refresh()
  fake.edit(P, '{ "version": 1, }')
  await manager.refresh()
  expect(log).toHaveLength(1)
  expect(log[0]?.startsWith('config: The file is not valid JSON: ')).toBe(true)
})

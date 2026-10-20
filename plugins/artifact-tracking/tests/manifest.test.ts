// The manifest read: the version of the mod from `<root>/.claude-plugin/plugin.json`, or "unknown" with the reason.
// Pure: the file system is a Map. Issue #65.
import { expect, test } from 'claude-code/testing'
import { announceVersion, MANIFEST_PATH, readVersion, UNKNOWN } from '../core/infra/manifest'

const ROOT = '/plugins/artifact-tracking'
const PATH = `${ROOT}/.claude-plugin/plugin.json`

/** The part of the ports the read needs: a read over a Map, and the root. A missing path rejects, as the engine does. */
const over = (files: Record<string, string>, root: () => string = () => ROOT) => ({
  fs: {
    read: async (path: string): Promise<string> => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return text
    },
  },
  plugin: {
    get root() {
      return root()
    },
  },
})

test('readVersion reads the version field of plugin.json under the plugin root', async () => {
  const reads: string[] = []
  const p = {
    fs: {
      read: async (path: string) => {
        reads.push(path)
        return '{"name":"artifact-tracking","version":"1.2.3","description":"x"}'
      },
    },
    plugin: { root: ROOT },
  }
  expect(await readVersion(p)).toEqual({ version: '1.2.3' })
  expect(reads).toEqual([PATH])
  expect(MANIFEST_PATH).toBe('.claude-plugin/plugin.json')
})

test('readVersion keeps a pre-release and build suffix as written and trims the edges', async () => {
  const r = await readVersion(over({ [PATH]: '{"version":" 0.2.0-rc.1+build.5 "}' }))
  expect(r.version).toBe('0.2.0-rc.1+build.5')
})

test('readVersion gives unknown and the reason when the file cannot be read', async () => {
  const r = await readVersion(over({}))
  expect(r.version).toBe(UNKNOWN)
  expect(r.problem).toContain('cannot read the manifest')
  expect(r.problem).toContain('ENOENT')
})

test('readVersion gives unknown when the engine refuses the read with a non-Error', async () => {
  const r = await readVersion({ fs: { read: () => Promise.reject('denied') }, plugin: { root: ROOT } })
  expect(r).toEqual({ version: UNKNOWN, problem: 'cannot read the manifest: denied' })
})

test('readVersion gives unknown when the plugin root cannot be read', async () => {
  const r = await readVersion(
    over({ [PATH]: '{"version":"1.0.0"}' }, () => {
      throw new Error('no plugin')
    }),
  )
  expect(r).toEqual({ version: UNKNOWN, problem: 'cannot read the manifest: no plugin' })
})

test('readVersion gives unknown for text that is not JSON', async () => {
  const r = await readVersion(over({ [PATH]: '{ not json' }))
  expect(r.version).toBe(UNKNOWN)
  expect(r.problem).toContain('not valid JSON')
})

test('readVersion gives unknown when the manifest has no usable version', async () => {
  for (const text of ['null', '[]', '"1.0.0"', '{}', '{"version":1}', '{"version":""}', '{"version":"  "}']) {
    const r = await readVersion(over({ [PATH]: text }))
    expect(r).toEqual({ version: UNKNOWN, problem: 'the manifest has no version string' })
  }
})

test('announceVersion hands the version to keep and logs one line that names it', async () => {
  const kept: string[] = []
  const lines: string[] = []
  await announceVersion(
    { ...over({ [PATH]: '{"version":"1.2.3"}' }), log: l => void lines.push(l) },
    v => void kept.push(v),
  )
  expect(kept).toEqual(['1.2.3'])
  expect(lines).toEqual(['version: 1.2.3'])
})

test('announceVersion keeps unknown and logs the reason when the manifest gives no version', async () => {
  const kept: string[] = []
  const lines: string[] = []
  await announceVersion({ ...over({}), log: l => void lines.push(l) }, v => void kept.push(v))
  expect(kept).toEqual([UNKNOWN])
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatch(/^version: unknown \(cannot read the manifest: .*ENOENT/)
})

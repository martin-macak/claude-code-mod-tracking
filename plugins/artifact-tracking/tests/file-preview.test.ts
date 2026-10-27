// The file provider of the preview (issue #57, L2): the view of a file row. It reads the file when the person asks, with `head -c`
// through the tool port, and returns blocks: a notice for what cannot be shown (a secret, a folder, an image, a binary file, a
// file that is gone, a cut), then the source with a line gutter. Through the LifecycleManager over fakePorts: the item list, the
// tracker events and the preview service are the real ones, and the fake `head` answers from the files of the world. Design study
// R14, R17 (view part), G3, G9: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787
import { expect, test } from 'claude-code/testing'
import { PROMPT_SECTION_ID } from '../core/infra/prompt'
import type { Json, JsonObject } from '../core/interfaces/items'
import type { FsStat, RunResult } from '../core/interfaces/ports'
import { PREVIEW_LIMITS } from '../core/lib/preview'
import { fileTracker } from '../trackers/file'
import { sizeText } from '../trackers/file/preview'
import { fakeConfig } from './fixtures/config-fs'
import { res } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

const HEAD_BYTES = '262144'
const SECRET_NOTICE =
  'A secret file: the path matches the secret rule (trackers.file.secretPaths adds more). The preview never reads it.'

/** A world with the file tracker alone. `head` answers from `w.files`, as the real one answers from the disk. */
function world(o: { slice?: JsonObject; head?: (path: string) => RunResult | undefined } = {}) {
  const heads: string[][] = []
  const t = managerWorld({
    trackers: () => [fileTracker()],
    config: specs =>
      fakeConfig({ specs, file: { version: 1, trackers: { file: { mime: false, ...o.slice } as JsonObject } } }),
    run: async argv => {
      if (argv[0] !== 'head') return undefined
      heads.push(argv)
      const path = argv[argv.length - 1] as string
      const custom = o.head?.(path)
      if (custom !== undefined) return custom
      const text = t.w.files[path]
      return text === undefined
        ? res('', 1, `head: ${path}: No such file or directory`)
        : res(text.slice(0, Number(argv[2])))
    },
  })
  t.w.env.HOME = '/home/u'
  t.m.facts.publish('auto.root', { cwd: '/work', top: '/work', at: 1 })
  /** A file on the disk of the world, and its row in the list. */
  const track = async (path: string, text?: string) => {
    if (text !== undefined) t.w.files[path] = text
    await t.call(
      'Write',
      { file_path: path },
      { result: { type: 'create', filePath: path, content: 'x', structuredPatch: [], originalFile: null } },
    )
    return `file:${path}`
  }
  const load = (key: string) => t.m.loadPreview(t.w.ports, 'file', key, 'view')
  return { ...t, heads, track, load }
}

const blocksOf = (c: { blocks: readonly { kind: string }[] }) => c.blocks.map(b => b.kind)
const noticesOf = (c: { blocks: readonly { kind: string; text?: string }[] }) =>
  c.blocks.flatMap(b => (b.kind === 'notice' ? [b.text] : []))

test('modes: a tracked file has the view and the diff (issue #254); a row that is not tracked has no preview', async () => {
  const t = world()
  const key = await t.track('/work/a.ts', 'x')
  expect(await t.m.previewModes(t.w.ports, 'file', key)).toEqual([
    { id: 'view', enabled: true },
    { id: 'diff', enabled: true },
  ])
  expect(await t.m.previewModes(t.w.ports, 'file', 'file:/work/none.ts')).toBeUndefined()
  expect(t.m.keys.hasPreview('file')).toBe(true) // so the rows of the file tracker draw `v`
})

test('view: the source of a text file, one code block with a line gutter, the path for the language, and a header that names the file', async () => {
  const t = world()
  const key = await t.track('/work/src/a.ts', 'export const one = 1\nexport const two = 2\n')
  const content = await t.load(key)
  expect(content).toEqual({
    title: 'src/a.ts',
    subtitle: 'code · view · 2 lines',
    blocks: [
      { kind: 'code', source: 'export const one = 1\nexport const two = 2\n', path: '/work/src/a.ts', startLine: 1 },
    ],
  })
  // One CLI call, with a cap in bytes and the end of options before the path, so a name that starts with `-` is no option.
  expect(t.heads).toEqual([['head', '-c', HEAD_BYTES, '--', '/work/src/a.ts']])
  expect(t.w.callOpts.at(-1)).toMatchObject({ timeoutMs: 5000 })
})

test('view: a file outside the session root keeps its absolute path in the header, and a one-line file says 1 line', async () => {
  const t = world()
  const key = await t.track('/etc/hosts', '127.0.0.1 localhost')
  const content = await t.load(key)
  expect(content.title).toBe('/etc/hosts')
  expect(content.subtitle).toBe('other · view · 1 line')
  expect(content.blocks).toEqual([{ kind: 'code', source: '127.0.0.1 localhost', path: '/etc/hosts', startLine: 1 }])
})

test('view: an empty file is a notice and no code block', async () => {
  const t = world()
  const content = await t.load(await t.track('/work/empty.txt', ''))
  expect(noticesOf(content)).toEqual(['Empty file.'])
  expect(blocksOf(content)).toEqual(['notice'])
  expect(t.heads).toEqual([]) // nothing to read
})

test('view: a file that is gone says so, in the words of what happened to it, and reads nothing', async () => {
  const t = world()
  const key = await t.track('/work/gone.ts') // tracked, and not on the disk of the world
  expect(noticesOf(await t.load(key))).toEqual([
    'The file is not there, or it could not be read: it was moved or deleted, or access was refused. Press d for the diff.',
  ])
  await t.call(
    'Bash',
    { command: 'rm gone.ts' },
    {
      result: {
        bashEditDiff: {
          files: [{ filePath: '/work/gone.ts', hunks: [], deleted: true }],
          moreFiles: 0,
          changedFiles: ['/work/gone.ts'],
        },
      },
    },
  )
  expect(noticesOf(await t.load(key))).toEqual(['Deleted by a Bash command: the file is gone. Press d for the diff.'])
  expect(t.heads).toEqual([])
})

test('view: a folder and a special file (a pipe, a socket, a device) are a notice: head is never run on them', async () => {
  const t = world()
  const dir = await t.track('/work/dir', 'x')
  const pipe = await t.track('/work/fifo', 'x')
  const stat = t.w.ports.fs.stat
  t.w.ports.fs.stat = async (path, opts): Promise<FsStat | null> => {
    const real = await stat(path, opts)
    if (real === null) return null
    return path === '/work/dir' ? { ...real, kind: 'dir' } : path === '/work/fifo' ? { ...real, kind: 'other' } : real
  }
  expect(noticesOf(await t.load(dir))).toEqual(['A folder, not a file.'])
  expect(noticesOf(await t.load(pipe))).toEqual(['Not a regular file: a device, a socket or a pipe.'])
  expect(t.heads).toEqual([])
})

test('view: an image shows its type and size and no pixels, and is not read', async () => {
  const t = world()
  const key = await t.track('/work/img.png', 'PNG DATA')
  const content = await t.load(key)
  expect(noticesOf(content)).toEqual(['Image, 8 B. The preview shows no pixels.'])
  expect(content.subtitle).toBe('image · view')
  expect(t.heads).toEqual([])
})

test('view: a binary file (a NUL in the first 8 KB) is a notice with its type and size, and no code block', async () => {
  const t = world()
  const key = await t.track('/work/data.bin', `abc\u0000${'x'.repeat(2000)}`)
  const content = await t.load(key)
  expect(blocksOf(content)).toEqual(['notice'])
  expect(noticesOf(content)).toEqual(['Binary file, other, 2.0 KB. The preview shows text only.'])
  // A NUL after the first 8 KB does not make a file binary: a long text file may hold one.
  const late = await t.track('/work/late.txt', `${`${'a'.repeat(40)}\n`.repeat(250)}\u0000end\n`) // the NUL sits at 10,250
  expect(blocksOf(await t.load(late))).toEqual(['code'])
})

test('view: a file over the line cap shows its first lines and a notice that comes first and counts them', async () => {
  const t = world({ slice: { preview: { maxLines: 100, maxChars: 60000 } } })
  const key = await t.track('/work/long.ts', Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  const content = await t.load(key)
  expect(blocksOf(content)).toEqual(['notice', 'code'])
  expect(noticesOf(content)).toEqual(['Truncated: the first 100 of 250 lines.'])
  const code = content.blocks[1] as { source: string }
  expect(code.source.split('\n')).toHaveLength(101) // 100 lines and the end of the last
  expect(code.source.startsWith('line 1\nline 2\n')).toBe(true)
  expect(code.source.endsWith('line 100\n')).toBe(true)
  expect(content.subtitle).toBe('code · view · 100 lines')
})

test('view: the character cap cuts at the last whole line, so a line is never cut in two', async () => {
  const t = world({ slice: { preview: { maxLines: 2000, maxChars: 5000 } } })
  const line = `${'x'.repeat(99)}\n` // 100 characters
  const key = await t.track('/work/wide.txt', line.repeat(80))
  const content = await t.load(key)
  const code = content.blocks.find(b => b.kind === 'code') as { source: string }
  expect(code.source.length).toBeLessThanOrEqual(5000)
  expect(code.source.length % 100).toBe(0)
  expect(code.source.length).toBe(5000) // 50 whole lines
  expect(noticesOf(content)).toEqual(['Truncated: the first 50 of 80 lines.'])
})

test('view: one line longer than the character cap is cut at the cap, and never between the two halves of a surrogate pair', async () => {
  const t = world({ slice: { preview: { maxLines: 2000, maxChars: 5000 } } })
  const key = await t.track('/work/min.js', `${'a'.repeat(4999)}😀${'b'.repeat(10)}\n`)
  const content = await t.load(key)
  const code = content.blocks.find(b => b.kind === 'code') as { source: string }
  expect(code.source).toBe('a'.repeat(4999)) // the emoji starts at 4999 and would be cut: it goes whole, or not at all
  expect(noticesOf(content)[0]).toMatch(/^Truncated/)
})

test('view: a file larger than the read cap shows what head read, without its last, unfinished line, and says how much it is', async () => {
  const t = world()
  const text = 'abcdefghi\n'.repeat(30_000) // 300,000 characters
  const key = await t.track('/work/big.log', text)
  const content = await t.load(key)
  const code = content.blocks.find(b => b.kind === 'code') as { source: string }
  expect(code.source.endsWith('\n')).toBe(true)
  expect(code.source.length).toBeLessThanOrEqual(60_000) // the line cap of the file tracker, 2,000 lines, comes first
  expect(noticesOf(content)).toEqual(['Truncated: the first 2000 lines of a file of 293 KB.'])
})

test('view: when head reports its output as cut, the file counts as larger than what was read', async () => {
  const t = world({ head: () => ({ ...res('one\ntwo\npart'), isStdoutTruncated: true }) })
  const key = await t.track('/work/x.txt', 'one\ntwo\nthree\n')
  const content = await t.load(key)
  expect((content.blocks.find(b => b.kind === 'code') as { source: string }).source).toBe('one\ntwo\n')
  expect(noticesOf(content)[0]).toMatch(/^Truncated: the first 2 lines of a file of /)
})

test('view: a secret file is a notice, and the file is never read: not .env, not a key, not what secretPaths adds', async () => {
  const t = world({ slice: { secretPaths: ['*.vault', '~/keys/**'] } })
  for (const path of [
    '/work/.env',
    '/work/tls/server.pem',
    '/home/u/.ssh/id_rsa',
    '/work/prod.vault',
    '/home/u/keys/a/b.txt',
  ]) {
    const key = await t.track(path, 'TOP-SECRET')
    const content = await t.load(key)
    expect(noticesOf(content), path).toEqual([SECRET_NOTICE])
    expect(blocksOf(content), path).toEqual(['notice'])
    expect(JSON.stringify(content), path).not.toContain('TOP-SECRET')
  }
  expect(t.heads).toEqual([])
  // `.env.example` is a template and shows.
  expect(blocksOf(await t.load(await t.track('/work/.env.example', 'KEY=')))).toEqual(['code'])
})

test('view: a home folder that the engine will not tell is no reason to stop: an ordinary file still shows', async () => {
  const t = world()
  const key = await t.track('/work/a.ts', 'one\n')
  t.w.ports.env.get = async () => {
    throw new Error('no implementation for env.get')
  }
  expect(blocksOf(await t.load(key))).toEqual(['code'])
})

test('view: a secret file is a notice in every mode: the secret rule comes before the mode, so a later mode meets it too (n13)', async () => {
  const t = world()
  const secret = await t.track('/work/.env', 'TOP-SECRET')
  const plain = await t.track('/work/a.ts', 'one\n')
  const diff = (key: string) => t.m.loadPreview(t.w.ports, 'file', key, 'diff')
  expect(noticesOf(await diff(secret))).toEqual([SECRET_NOTICE])
  expect(JSON.stringify(await diff(secret))).not.toContain('TOP-SECRET')
  // A mode that the provider does not have says so, for a file that is no secret.
  const detail = (key: string) => t.m.loadPreview(t.w.ports, 'file', key, 'detail')
  expect(noticesOf(await detail(plain))).toEqual(['This mode is not available for a file.'])
  expect(noticesOf(await detail(secret))).toEqual([SECRET_NOTICE])
  expect(t.heads).toEqual([])
  expect(t.w.calls.filter(c => c[0] === 'git')).toEqual([]) // the diff of a secret file never runs git
})

test('view: a secretPaths glob that starts with ~/ and a home folder that the engine will not tell: no preview reads a file, and the notice says why (m15)', async () => {
  const t = world({ slice: { secretPaths: ['~/private/**'] } })
  const key = await t.track('/work/a.ts', 'FILE-TEXT\n')
  t.w.ports.env.get = async () => {
    throw new Error('no implementation for env.get')
  }
  const content = await t.load(key)
  expect(blocksOf(content)).toEqual(['notice'])
  expect(noticesOf(content)[0]).toMatch(/^A secretPaths glob starts with ~\/ and the home folder is not known/)
  expect(JSON.stringify(content)).not.toContain('FILE-TEXT')
  expect(t.heads).toEqual([])
  // With the home folder known the same file shows, and an empty one counts as unknown.
  t.w.ports.env.get = async () => '/home/u'
  expect(blocksOf(await t.load(key))).toEqual(['code'])
  t.w.ports.env.get = async () => ''
  expect(blocksOf(await t.load(key))).toEqual(['notice'])
})

test('view: a path that became a link to a key since the row was made is a secret too: the real path is checked when the preview opens (m16)', async () => {
  const t = world()
  const key = await t.track('/work/notes.txt', 'TOP-SECRET')
  expect(blocksOf(await t.load(key))).toEqual(['code']) // an ordinary file so far
  const stat = t.w.ports.fs.stat
  t.w.ports.fs.stat = async (path, opts): Promise<FsStat | null> => {
    const real = await stat(path, opts)
    return real !== null && path === '/work/notes.txt' && opts?.resolve === true
      ? { ...real, isLink: true, realPath: '/home/u/.ssh/id_ed25519' }
      : real
  }
  t.heads.length = 0
  const content = await t.load(key)
  expect(noticesOf(content)).toEqual([SECRET_NOTICE])
  expect(JSON.stringify(content)).not.toContain('TOP-SECRET')
  expect(t.heads).toEqual([]) // the stat read no content, and head never ran
})

test('view: a link with an innocent name that leads to a key is a secret from its first sighting: capture keys the row by where the file landed (m20)', async () => {
  const t = world()
  const stat = t.w.ports.fs.stat
  t.w.ports.fs.stat = async (path, opts): Promise<FsStat | null> => {
    const real = await stat(path, opts)
    return real !== null && path === '/work/notes.txt' && opts?.resolve === true
      ? { ...real, isLink: true, realPath: '/home/u/.ssh/id_ed25519' }
      : real
  }
  await t.track('/work/notes.txt', 'TOP-SECRET') // the row is keyed by where the file landed, and keeps the spelled path as its label
  const key = 'file:/home/u/.ssh/id_ed25519'
  expect(t.keys()).toEqual([key])
  const content = await t.load(key)
  expect(noticesOf(content)).toEqual([SECRET_NOTICE])
  expect(JSON.stringify(content)).not.toContain('TOP-SECRET')
  expect(t.heads).toEqual([])
})

test('view: a file whose stat fails says that it may be missing or refused (m16)', async () => {
  const t = world()
  const key = await t.track('/work/locked.txt', 'x')
  t.w.ports.fs.stat = async () => null // a stat that fails: a missing file and a refused one look alike
  expect(noticesOf(await t.load(key))).toEqual([
    'The file is not there, or it could not be read: it was moved or deleted, or access was refused. Press d for the diff.',
  ])
})

test('sizeText: three digits at most, and the unit steps up at the rounded value (m11)', () => {
  for (const [bytes, text] of [
    [0, '0 B'],
    [8, '8 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [2004, '2.0 KB'],
    [102_349, '100 KB'], // 99.95 KB rounds to the three digits of 100 KB
    [102_350, '100 KB'],
    [102_399, '100 KB'],
    [300_000, '293 KB'],
    [1_048_063, '1023 KB'],
    [1_048_064, '1.0 MB'], // 1023.5 KB
    [1_048_575, '1.0 MB'], // not `1024 KB`
    [1_572_864, '1.5 MB'],
    [104_857_600, '100 MB'],
    [1_073_741_824, '1.0 GB'],
  ] as const)
    expect(sizeText(bytes), String(bytes)).toBe(text)
})

test('view: the notice of a binary file and of an image names the MIME type when file answered one, and falls back to the type of the map (m12)', async () => {
  const t = world()
  const bin = await t.track('/work/a.dat', `x\u0000${'y'.repeat(1_572_862)}`)
  const img = await t.track('/work/p.png', 'PNG')
  const odd = await t.track('/work/b.dat', `x\u0000${'y'.repeat(100)}`)
  const mime = (types: Record<string, string>) =>
    t.w.state.set(
      'items',
      (t.w.state.get('items') as JsonObject[]).map(i =>
        types[i.key as string] ? { ...i, mime: types[i.key as string] } : i,
      ) as unknown as Json,
    )
  mime({ [bin]: 'application/octet-stream', [img]: 'image/png', [odd]: 'unknown' })
  expect(noticesOf(await t.load(bin))).toEqual([
    'Binary file, application/octet-stream, 1.5 MB. The preview shows text only.',
  ])
  expect(noticesOf(await t.load(img))).toEqual(['Image (image/png), 3 B. The preview shows no pixels.'])
  // `unknown` is no answer: the words of the map, as when `file` was never asked.
  expect(noticesOf(await t.load(odd))).toEqual(['Binary file, other, 102 B. The preview shows text only.'])
})

test('view: one line larger than the read cap shows its first part, and the notice says the line is cut and how large the file is (m13)', async () => {
  const t = world()
  const content = await t.load(await t.track('/work/min.js', 'x'.repeat(300_000)))
  expect(noticesOf(content)).toEqual(['Truncated: a line is cut at 60000 characters, in a file of 293 KB.'])
  expect((content.blocks.find(b => b.kind === 'code') as { source: string }).source).toBe('x'.repeat(60_000))
  expect(content.subtitle).toBe('code · view · 1 line')
})

test('view: a first line over the character cap says that the lines after it are not shown (m14)', async () => {
  const t = world({ slice: { preview: { maxLines: 2000, maxChars: 5000 } } })
  const key = await t.track('/work/data.csv', `${'h'.repeat(6000)}\nrow 1\nrow 2\n`)
  const content = await t.load(key)
  expect(noticesOf(content)).toEqual([
    'Truncated: the first line is cut at 5000 characters, and the lines after it are not shown.',
  ])
  expect((content.blocks.find(b => b.kind === 'code') as { source: string }).source).toBe('h'.repeat(5000))
})

test('view: a first line over the character cap and a second line that the read cut off says that the lines after it are not shown (m14)', async () => {
  const t = world()
  // 391 KB: the first line is over the cap of 60,000 characters, and the read of 256 KiB ends in the middle of the second line. That
  // unfinished line goes, so one line is left to draw, and the file still has lines that the pane does not show.
  const key = await t.track('/work/two.ts', `${'h'.repeat(70_000)}\n${'z'.repeat(330_000)}`)
  const content = await t.load(key)
  expect(noticesOf(content)).toEqual([
    'Truncated: the first line is cut at 60000 characters, and the lines after it are not shown.',
  ])
  expect((content.blocks.find(b => b.kind === 'code') as { source: string }).source).toBe('h'.repeat(60_000))
  expect(content.subtitle).toBe('code · view · 1 line')
})

test('view: a row that is no longer tracked, a failed read and a head that cannot start each say so, in one notice', async () => {
  const t = world({
    head: path =>
      path === '/work/denied.txt' ? res('', 1, 'head: /work/denied.txt: Permission denied\nmore') : undefined,
  })
  expect(noticesOf(await t.load('file:/work/none.ts'))).toEqual(['This file is not tracked any more.'])
  const denied = await t.track('/work/denied.txt', 'x')
  expect(noticesOf(await t.load(denied))).toEqual([
    'Could not read the file: head: /work/denied.txt: Permission denied',
  ])
  const silent = world({ head: () => res('', 3) })
  expect(noticesOf(await silent.load(await silent.track('/work/s.txt', 'x')))).toEqual([
    'Could not read the file: exit 3',
  ])
  const absent = world({
    head: () => {
      throw new Error('spawn head ENOENT')
    },
  })
  expect(noticesOf(await absent.load(await absent.track('/work/s.txt', 'x')))).toEqual([
    'Could not read the file: spawn head ENOENT',
  ])
})

test('view: the caps of the config never go above the limits of the drawing, and the config says where they stand', () => {
  const slice = world().cfg.slice('file') as { preview: { maxLines: number; maxChars: number } }
  expect(slice.preview).toEqual({ maxLines: 2000, maxChars: 60000 })
  expect(slice.preview.maxLines).toBeLessThanOrEqual(PREVIEW_LIMITS.maxLines)
  expect(slice.preview.maxChars).toBeLessThanOrEqual(PREVIEW_LIMITS.maxChars)
})

test('the content of a preview goes to no state, no store and no prompt, and the /track text never holds it (issue #57, R13)', async () => {
  const t = world({ slice: { prompt: { enabled: true } } })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const key = await t.track('/work/a.ts', 'const MARKER_OF_THE_FILE = 1\n')
  // The preview is open: the state names the row, and the pane holds the content in memory alone.
  t.w.state.set('preview', { rowId: key, owner: 'file', mode: 'view' })
  const content = await t.load(key)
  expect(JSON.stringify(content)).toContain('MARKER_OF_THE_FILE')
  // Everything that could carry it is written now: the stored copy of the session, and the prompt that a turn rebuilds.
  await t.m.turnComplete(t.w.ports, { input: { reason: 'answer' } })
  await t.m.flushNow()
  // The checks can fail: the store holds the copy of the session, and the prompt lists the file, so each has something to leak into.
  const stored = [...t.w.store.entries()].filter(([k]) => k.startsWith('v2:s:'))
  expect(stored.length).toBeGreaterThan(0)
  expect(JSON.stringify(stored)).toContain('/work/a.ts')
  const prompt = t.m.compose({ traits: [] }, []).find(s => s.id === PROMPT_SECTION_ID)?.text ?? ''
  expect(prompt).toContain('a.ts')
  expect(JSON.stringify([...t.w.state.entries()])).toContain(key) // the state names the row, and nothing else
  const everything = JSON.stringify([...t.w.state.entries(), ...t.w.store.entries(), t.w.prompts, t.w.logs, prompt])
  expect(everything).not.toContain('MARKER_OF_THE_FILE')
  expect(await t.m.track(t.w.ports, '')).not.toContain('MARKER_OF_THE_FILE')
})

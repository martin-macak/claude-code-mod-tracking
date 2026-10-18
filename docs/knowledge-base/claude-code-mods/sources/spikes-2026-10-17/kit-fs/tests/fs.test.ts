import { expect, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const DIR = '<SPIKES>/kit-fs'
const run = ($: { command: { run: (a: never) => Promise<unknown> } }, args: string) =>
  $.command.run({ command: 'fsprobe', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never) as Promise<{ text?: string }>

test('G06-1: unstubbed fs.write/exists/read on a path under the scratchpad', async $ => {
  const w = await run($, `write ${DIR}/out-test/new.txt hello`)
  console.log('UNSTUBBED write  ->', w.text)
  const x = await run($, `exists ${DIR}/out-real/exists.txt`)
  console.log('UNSTUBBED exists ->', x.text)
  const r = await run($, `read ${DIR}/out-real/exists.txt`)
  console.log('UNSTUBBED read   ->', r.text)
  const root = await run($, 'readroot')
  console.log('UNSTUBBED read of $.plugin.root file ->', root.text)
  expect(w.text).toContain('no implementation for fs.write')
})

test('G06-2: the Engine type and the test body have no fs noun at all', async $ => {
  // tsc: Property 'fs' does not exist on type 'Engine'. At run time the noun is undefined.
  expect((($ as unknown) as { fs?: unknown }).fs).toBeUndefined()
})

test('G06-3: stub pattern - Map-backed fake on fs.read / fs.write / fs.exists', async ($, on) => {
  const disk = new Map<string, string>([[`${DIR}/cfg.json`, '{"a":1}']])
  const calls: string[] = []
  on('fs.exists', (_$, e) => {
    calls.push('exists ' + e.path)
    return { value: disk.has(e.path) }
  })
  on('fs.read', (_$, e) => {
    calls.push('read ' + e.path + ' as=' + e.as)
    const t = disk.get(e.path)
    if (t === undefined) return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
    return { value: t }
  })
  on('fs.write', (_$, e) => {
    calls.push('write ' + e.path)
    disk.set(e.path, e.text)
    return { value: undefined }
  })
  expect((await run($, `exists ${DIR}/cfg.json`)).text).toBe('OK exists=true')
  expect((await run($, `exists ${DIR}/nope.json`)).text).toBe('OK exists=false')
  expect((await run($, `read ${DIR}/cfg.json`)).text).toBe('OK read="{\\"a\\":1}"')
  const miss = await run($, `read ${DIR}/nope.json`)
  console.log('STUB deny (ENOENT) ->', miss.text)
  expect(miss.text).toContain('ENOENT')
  expect((await run($, `write ${DIR}/deep/dir/out.txt hi there`)).text).toBe('OK write')
  expect(disk.get(`${DIR}/deep/dir/out.txt`)).toBe('hi there')
  console.log('STUB calls ->', JSON.stringify(calls))
})

test('G06-4: a deny stub on fs.write is what the mod sees as a rejection', async ($, on) => {
  on('fs.write', () => ({ deny: 'EACCES: permission denied' }))
  const w = await run($, `write ${DIR}/x.txt a`)
  console.log('STUB deny write ->', w.text)
  expect(w.text).toContain('EACCES')
})

import { mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

for (const scn of ['direct:same:3', 'direct:uniq:3', 'captured:uniq:3', 'timer:uniq:3', 'peer:uniq:3']) {
  test(scn, { timeoutMs: 15000 }, async ($, on) => {
    const store = new Map<string, unknown>()
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => {
      store.set(e.key, JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
    // Bottom: the engine's own run of the tool.
    on('tool.call', () => ({ ref: 'r', result: 'engine' }) as never)
    const clock = mock.clock(on)
    const t0 = Date.now()
    const p = $.command.run({ command: 'probe', args: scn, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
    await clock.settle()
    await clock.advance(1000)
    let res = ''
    try {
      res = JSON.stringify(await p)
    } catch (err) {
      res = 'REJECTED ' + String((err as Error).message)
    }
    console.log(`== ${scn} (${Date.now() - t0} ms) -> ${res}`)
    for (const l of JSON.parse(String(store.get('rec') ?? '[]')) as string[]) console.log('   ' + l)
  })
}

import { mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

for (const start of ['a', 'r']) {
  test('cycle start ' + start, { timeoutMs: 15000 }, async ($, on) => {
    const store = new Map<string, unknown>()
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => {
      store.set(e.key, JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
    on('tool.call', () => ({ ref: 'r', result: 'engine' }) as never)
    const clock = mock.clock(on)
    mock.session(on)
    const p = $.command.run({ command: 'probe', args: start, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
    await clock.settle()
    await clock.advance(1000)
    console.log(`== start ${start} -> ${JSON.stringify(await p)}`)
    for (const l of JSON.parse(String(store.get('rec') ?? '[]')) as string[]) console.log('   ' + l)
  })
}

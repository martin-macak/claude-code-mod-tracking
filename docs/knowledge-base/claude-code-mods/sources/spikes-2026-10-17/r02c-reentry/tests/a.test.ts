import { mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const SCENARIOS = [
  'direct:same:before:3',
  'direct:uniq:before:3',
  'direct:uniq:after:3',
  'captured:same:before:3',
  'captured:uniq:before:3',
  'timer:uniq:before:3',
  'peer:uniq:before:3',
] as const

for (const scn of SCENARIOS) {
  test(scn, { timeoutMs: 15000 }, async ($, on) => {
    const store = new Map<string, unknown>()
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => {
      store.set(e.key, JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
    const clock = mock.clock(on)
    const ses = mock.session(on)
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
    console.log('   kit rows stored: ' + ses.appended().length)
  })
}

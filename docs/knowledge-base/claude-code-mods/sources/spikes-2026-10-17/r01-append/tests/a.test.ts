import { mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

function world(on: Parameters<typeof mock.clock>[0]) {
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  return store
}

const row = (text: string) =>
  ({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'm' },
    uuid: 'u-test',
  }) as never

async function run(name: string, text: string, $: { session: { append: (a: never) => Promise<unknown> } }, store: Map<string, unknown>, ses: { appended: () => readonly unknown[] }) {
  const t0 = Date.now()
  let res = ''
  try {
    res = JSON.stringify(await $.session.append(row(text))).slice(0, 120)
  } catch (err) {
    res = 'REJECTED ' + String((err as Error).message)
  }
  console.log(`== ${name} (${Date.now() - t0} ms) result=${res}`)
  console.log('STATS ' + String(store.get('stats')))
  for (const l of JSON.parse(String(store.get('rec') ?? '[]')) as string[]) console.log('  ' + l)
  console.log('  kit-appended rows: ' + ses.appended().length)
}

for (const [name, text] of [
  ['same/before/cap3', 'probe:same:before:3'],
  ['uniq/before/cap3', 'probe:uniq:before:3'],
  ['uniq/after/cap3', 'probe:uniq:after:3'],
] as const) {
  test(name, async ($, on) => {
    const store = world(on)
    const ses = mock.session(on)
    await run(name, text, $ as never, store, ses)
  })
}

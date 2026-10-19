import { expect, mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const cmd = ($: { command: { run: (a: never) => Promise<unknown> } }, command: string) =>
  $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never) as Promise<{ text?: string }>

function world(on: Parameters<typeof mock.clock>[0], idRef: { id: string }) {
  mock.clock(on)
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.id', () => ({ value: idRef.id }))
  return store
}

test('G11-1: $.session.end({reason: clear}) runs the hook; what $.state and $.session.id() hold', async ($, on) => {
  const cur = { id: 'sess-1' }
  const store = world(on, cur)
  // Bottom: the engine's end step. The kit has nothing beneath the plugins for session.end.
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))

  await cmd($, 'bump')
  await cmd($, 'bump')
  console.log('BEFORE end peek ->', (await cmd($, 'peek')).text)

  const r = await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  console.log('END result ->', JSON.stringify(r))
  console.log('STORE (written inside the hook) ->', JSON.stringify([...store.entries()]))
  expect([...store.keys()]).toHaveLength(1)

  console.log('AFTER end, same stub id peek ->', (await cmd($, 'peek')).text)

  // The real engine would now answer a new id and reset $.state. The kit does neither: only the stub changes.
  cur.id = 'sess-2'
  console.log('AFTER id flip peek ->', (await cmd($, 'peek')).text)
})

test('G11-2: hook that calls next(e) with no bottom stub', async $ => {
  let msg = 'resolved'
  try {
    msg = 'resolved ' + JSON.stringify(await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } }))
  } catch (err) {
    msg = 'rejected: ' + String((err as Error).message)
  }
  console.log('NO-BOTTOM session.end ->', msg)
})

test('G11-3: other reasons run the same hook (exit, resume, logout, other)', async ($, on) => {
  const store = world(on, { id: 'sess-1' })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  for (const reason of ['prompt_input_exit', 'resume', 'logout', 'other', 'clear'] as const) {
    await $.session.end({ reason, sessionId: 'sess-1', resume: { id: 'sess-1' } })
  }
  const rs = [...store.values()].map(v => (v as { reason: string }).reason)
  console.log('REASONS seen by hook ->', JSON.stringify(rs))
})

test('G11-4: $.classic.SessionEnd driver exists and raises the classic event', async ($, on) => {
  world(on, { id: 'sess-1' })
  let ended = 'n/a'
  on('classic.SessionEnd', () => ({}))
  try {
    ended = JSON.stringify(await $.classic.SessionEnd({ reason: 'clear' }))
  } catch (err) {
    ended = 'rejected: ' + String((err as Error).message)
  }
  console.log('CLASSIC SessionEnd ->', ended)
})

test('G11-5: driver = $.session.end({clear}) then flip the stub id, over an id-keyed state stub (world.ts isolateState)', async ($, on) => {
  const cur = { id: 'sess-1' }
  const store = world(on, cur)
  const states = new Map<string, { value: unknown; version: number }>()
  const at = (e: { plugin: string; key: string; id?: string }) => `${cur.id}|${e.plugin}|${e.key}|${e.id ?? ''}`
  on('state.get', (_$, e) => {
    const s = states.get(at(e))
    return { value: { value: s?.value, version: s?.version ?? 0 } as never }
  })
  on('state.set', (_$, e) => {
    const v = (states.get(at(e))?.version ?? 0) + 1
    states.set(at(e), { value: JSON.parse(JSON.stringify(e.value ?? null)), version: v })
    return { value: { isSet: true, version: v } }
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))

  await cmd($, 'bump')
  await cmd($, 'bump')
  expect((await cmd($, 'peek')).text).toBe('{"n":2,"id":"sess-1"}')

  // The /clear driver.
  const clear = async (next: string) => {
    await $.session.end({ reason: 'clear', sessionId: cur.id, resume: { id: cur.id } })
    cur.id = next
  }
  await clear('sess-2')
  console.log('AFTER clear driver peek ->', (await cmd($, 'peek')).text)
  console.log('hook saw (leaving session) ->', JSON.stringify(store.get('end-clear')))
  console.log('state buckets ->', JSON.stringify([...states.entries()]))
  expect((await cmd($, 'peek')).text).toBe('{"n":0,"id":"sess-2"}')
})

test('G11-6: full /clear driver = session.end(clear) + id flip + classic.SessionStart(clear), the new-session hook sees the new id and a fresh state', async ($, on) => {
  const cur = { id: 'sess-1' }
  const store = world(on, cur)
  const states = new Map<string, { value: unknown; version: number }>()
  const at = (e: { plugin: string; key: string; id?: string }) => `${cur.id}|${e.plugin}|${e.key}|${e.id ?? ''}`
  on('state.get', (_$, e) => ({ value: { value: states.get(at(e))?.value, version: states.get(at(e))?.version ?? 0 } as never }))
  on('state.set', (_$, e) => {
    const v = (states.get(at(e))?.version ?? 0) + 1
    states.set(at(e), { value: JSON.parse(JSON.stringify(e.value ?? null)), version: v })
    return { value: { isSet: true, version: v } }
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))

  await cmd($, 'bump')
  const clear = async (next: string) => {
    await $.session.end({ reason: 'clear', sessionId: cur.id, resume: { id: cur.id } })
    cur.id = next
    await $.classic.SessionStart({ source: 'clear' })
  }
  await clear('sess-2')
  console.log('start hook saw ->', JSON.stringify(store.get('start-clear')))
  console.log('end hook saw   ->', JSON.stringify(store.get('end-clear')))
  expect(store.get('start-clear')).toEqual({ source: 'clear', idInside: 'sess-2', nInside: 0 })
})

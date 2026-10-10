// Hook tests. The kit raises a `session.append` row with any door through `$.session.append(row)`:
// the call takes the event's whole input, and the kit's bottom stores the row as a session does.
// A live session (see the KB page) is still needed for what the kit cannot show: the real rows,
// the real renderer, the real transcript load.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionAppendInput } from 'claude-code'

const SESSION = 'sess-1'
/** The session id the stub answers. A test sets it to what /clear would do. */
const current = { id: SESSION }

/** Stubs for the engine nouns the mod calls. Register before the first call on `$`. */
function world(on: On, seed: Record<string, unknown> = {}, messages: unknown[] = [], registered: string[] = []) {
  const clock = mock.clock(on)
  const store = new Map<string, unknown>(Object.entries(seed))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  current.id = SESSION
  on('session.id', () => ({ value: current.id }))
  on('session.messages', () => ({ value: messages as never })) // the stub's value type is narrower than the call's
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return { clock, store }
}

/** `$.command.run` in a test takes the whole event input. */
const run = ($: Engine, args = '') =>
  $.command.run({ command: 'links', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const response = (text: string, uuid = 'r1', agentId?: string): SessionAppendInput =>
  ({
    door: 'response',
    origin: { kind: 'model', model: 'm' },
    uuid,
    agentId,
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  })

const toolResult = (content: unknown, uuid = 't1'): SessionAppendInput =>
  ({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid,
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: content }] },
  })

test('response row: links are listed by /links, and the row is stored as made', async ($, on) => {
  world(on)
  const row = response('See [docs](https://docs.example/a "T"), https://bare.example/b. Not `https://code.example/c`.')
  const stored = await $.session.append(row)
  expect(stored.message?.content).toEqual(row.message.content)
  const out = await run($)
  expect(out.text).toContain('2 links')
  expect(out.text).toContain('docs - https://docs.example/a (inline)')
  expect(out.text).toContain('https://bare.example/b (bare)')
  expect(out.text).not.toContain('code.example')
})

test('same URL twice is one entry with a count; a subagent row is tagged', async ($, on) => {
  world(on)
  await $.session.append(response('[a](https://same.example/x)', 'r1'))
  await $.session.append(response('again https://same.example/x', 'r2', 'agent-7'))
  const out = await run($)
  expect(out.text).toContain('1 link:')
  expect(out.text).toContain('(inline, x2)')
})

test('subagent text alone is tagged', async ($, on) => {
  world(on)
  await $.session.append(response('[a](https://sub.example/x)', 'r1', 'agent-7'))
  expect((await run($)).text).toContain('(inline, subagent)')
})

test('non-web and plain-text links are hidden until /links all', async ($, on) => {
  world(on)
  await $.session.append(response('[t](tel:+1) [m](mailto:a@b.c) [ref][r]\n[r]: https://ref.example/\n'))
  expect((await run($)).text).toContain('https://ref.example/ (bare)')
  expect((await run($)).text).not.toContain('tel:')
  const all = (await run($, 'all')).text ?? ''
  expect(all).toContain('tel:+1')
  expect(all).toContain('mailto:a@b.c (mailto, plain text)')
})

test('tool-result row: raw OSC 8 in a string and in block content', async ($, on) => {
  world(on)
  const osc = '\x1b]8;id=k;https://tool.example/one\x07one\x1b]8;;\x07 \x1b]8;;https://tool.example/two\x1b\\two\x1b]8;;\x1b\\'
  await $.session.append(toolResult(osc, 't1'))
  await $.session.append(toolResult([{ type: 'text', text: '\x1b]8;;https://tool.example/three\x07three\x1b]8;;\x07' }], 't2'))
  const text = (await run($)).text ?? ''
  expect(text).toContain('3 links')
  expect(text).toContain('one - https://tool.example/one (osc8)')
  expect(text).toContain('https://tool.example/two (osc8)')
  expect(text).toContain('three - https://tool.example/three (osc8)')
})

test('tool-result row: plain URLs in tool output are not captured (only OSC 8 is)', async ($, on) => {
  world(on)
  await $.session.append(toolResult('see https://plain.example/p and [md](https://md.example/q)'))
  expect((await run($)).text).toContain('No web links captured yet')
})

test('other doors are not scanned: prompt, attachment, compaction', async ($, on) => {
  world(on)
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: 'p1', message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'https://prompt.example/' }] } })
  await $.session.append({ door: 'attachment', origin: { kind: 'engine' }, uuid: 'a1', message: { type: 'attachment', name: 'x', role: 'user', content: [{ type: 'text', text: 'https://attachment.example/' }] } })
  await $.session.append({ door: 'compaction', origin: { kind: 'engine' }, uuid: 'c1', message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'Summary: https://compaction.example/' }] } })
  expect((await run($)).text).toContain('No web links captured yet')
})

test('a burst of rows makes one $.store write, after the delay (the deferred flush)', async ($, on) => {
  const { clock, store } = world(on)
  await $.session.append(response('https://one.example/'))
  await $.session.append(response('https://two.example/', 'r2'))
  expect(store.size).toBe(0)
  await clock.advance(2000)
  expect(store.has('s:' + SESSION)).toBe(true)
  expect((store.get('s:' + SESSION) as { links: unknown[] }).links.length).toBe(2)
  expect(store.get('index')).toEqual([SESSION])
})

test('the store keeps the 20 newest sessions', async ($, on) => {
  const seed: Record<string, unknown> = { index: Array.from({ length: 25 }, (_, k) => 'old' + k) }
  for (const id of seed.index as string[]) seed['s:' + id] = { links: [] }
  const { clock, store } = world(on, seed)
  await $.session.append(response('https://one.example/'))
  await clock.advance(2000)
  const index = store.get('index') as string[]
  expect(index.length).toBe(20)
  expect(index[0]).toBe(SESSION)
  expect(store.has('s:old24')).toBe(false)
  expect(store.has('s:old18')).toBe(true)
})

test('session.start loads a resumed transcript: assistant text and tool-use results', async ($, on) => {
  world(on, {}, [
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: 'First [one](https://one.example/a) and https://fenced.example/', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't', tool: 'Bash', input: {}, text: '\x1b]8;;https://tool.example/old\x07old\x1b]8;;\x07' }] },
    { role: 'assistant', text: 'Done: https://two.example/x.', toolUses: [] },
  ])
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  const text = (await run($)).text ?? ''
  expect(text).toContain('4 links')
  expect(text).toContain('https://one.example/a')
  expect(text).toContain('old - https://tool.example/old')
  expect(text).toContain('https://two.example/x (bare)')
})

test('session.start registers /links', async ($, on) => {
  const registered: string[] = []
  world(on, {}, [], registered)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  expect(registered).toEqual(['links'])
})

test('/clear: the id changes and $.state is empty, so the stored copy of the session just left comes back', async ($, on) => {
  const old = { links: [{ url: 'https://kept.example/', via: 'bare', kind: 'link', web: true, door: 'response', uuid: 'u', n: 1 }] }
  world(on, { index: ['previous'], 's:previous': old })
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false }) // remembers sess-1
  current.id = 'sess-2' // what /clear does
  expect((await run($)).text).toContain('https://kept.example/')
})

test('/clear: the next captured row also triggers the restore, and the new link joins the old ones', async ($, on) => {
  const old = { links: [{ url: 'https://kept.example/', via: 'bare', kind: 'link', web: true, door: 'response', uuid: 'u', n: 1 }] }
  world(on, { index: ['previous'], 's:previous': old })
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  current.id = 'sess-2'
  await $.session.append(response('https://new.example/'))
  const text = (await run($)).text ?? ''
  expect(text).toContain('2 links')
  expect(text).toContain('https://kept.example/')
  expect(text).toContain('https://new.example/')
})

test('/resume: an id the store already knows gets its own stored copy, not the last other session', async ($, on) => {
  const link = (url: string) => ({ url, via: 'bare', kind: 'link', web: true, door: 'response', uuid: 'u', n: 1 })
  world(on, { index: ['newest', 'wanted'], 's:newest': { links: [link('https://newest.example/')] }, 's:wanted': { links: [link('https://wanted.example/')] } })
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  current.id = 'wanted' // what /resume wanted does
  const text = (await run($)).text ?? ''
  expect(text).toContain('https://wanted.example/')
  expect(text).not.toContain('newest.example')
})

test('an unchanged id restores nothing: a new process does not pull an older session in', async ($, on) => {
  world(on, { index: ['previous'], 's:previous': { links: [{ url: 'https://stale.example/', via: 'bare', kind: 'link', web: true, door: 'response', uuid: 'u', n: 1 }] } })
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await $.session.append(response('https://live.example/'))
  const text = (await run($)).text ?? ''
  expect(text).toContain('https://live.example/')
  expect(text).not.toContain('stale.example')
})

test('the list is capped at 500 and /links shows the last 30 by default, or the last N asked for', async ($, on) => {
  world(on)
  for (let k = 0; k < 520; k += 40) {
    const text = Array.from({ length: 40 }, (_, j) => `https://e.example/${k + j}`).join(' ')
    await $.session.append(response(text, 'r' + k))
  }
  const def = (await run($)).text ?? ''
  expect(def).toContain('500 links, last 30, 20 older dropped:')
  expect(def).toContain('https://e.example/519')
  expect(def).not.toContain('https://e.example/19 ') // dropped from the front
  const five = (await run($, '5')).text ?? ''
  expect(five.split('\n').length).toBe(6)
})

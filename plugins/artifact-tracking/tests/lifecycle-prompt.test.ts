// The prompt text on a real LifecycleManager over fakePorts: when it is rebuilt (start, a switch, a main-loop turn, a
// config change, a dismiss, a clear), when it is not (a data change alone, a subagent turn), what a failing tracker or
// view read does and that `compose` touches no port. The trackers are two fakes whose `prompt` reads a plain object.
// The last tests run the real trackers: a dismiss and a clear drop the items, and one rebuild reads the state once.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 6 (S1, S2, S12).
import { expect, test } from 'claude-code/testing'
import type { LifecycleManager } from '../core/infra/lifecycle'
import { PROMPT_FRAME, PROMPT_SECTION_ID } from '../core/infra/prompt'
import type { JsonObject } from '../core/interfaces/items'
import type { PromptSection } from '../core/interfaces/prompt'
import type { Tracker } from '../core/interfaces/tracker'
import { type FakeConfig, fakeConfig } from './fixtures/config-fs'
import { promptRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** `a` has opted in, `b` has not. */
const A_ON = { trackers: { a: { prompt: { enabled: true } } } }
const BOTH_ON = { trackers: { a: { prompt: { enabled: true } }, b: { prompt: { enabled: true } } } }
const MAIN = { input: { reason: 'answer' } }
const SUBAGENT = { input: { agentId: 'ag-1', reason: 'answer' } }

function setup(file: JsonObject = A_ON) {
  const state = { a: ['a: one'] as readonly string[], b: ['b: one'] as readonly string[], boom: '' }
  const calls = { a: 0, b: 0 }
  const tracker = (id: 'a' | 'b', order: number): Tracker => ({
    id,
    order,
    // The raw slice stands: the settings are checked by `promptSettings`, as for a real tracker.
    config: { defaults: {}, normalise: raw => raw },
    init: () => {},
    store: ctx => ctx.config.slice(),
    prompt: () => {
      calls[id]++
      if (id === 'a' && state.boom) throw new Error(state.boom)
      return state[id]
    },
  })
  const noPrompt: Tracker = {
    id: 'plain',
    order: 30,
    config: { defaults: {}, normalise: raw => raw },
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
  let fake!: FakeConfig
  const world = managerWorld({
    trackers: () => [],
    extra: [tracker('a', 10), tracker('b', 20), noPrompt],
    config: specs => (fake = fakeConfig({ specs, file })),
  })
  const { w, m } = world
  const sections = (traits: Parameters<typeof m.compose>[0]['traits'] = []): readonly PromptSection[] =>
    m.compose({ traits }, [])
  const text = (): string | undefined => sections()[0]?.text
  const logged = (what: string): string[] => w.logs.filter(l => l.startsWith(what))
  return { w, m, state, calls, fake, sections, text, logged }
}

const framed = (...lines: string[]): string => `${PROMPT_FRAME}\n${lines.join('\n')}`

/** Replaces every function of the ports, deep, by one that notes its path first. The manager holds the same object. */
function record(root: object, seen: string[], path = '', done = new Set<object>()): void {
  if (done.has(root)) return
  done.add(root)
  for (const [key, value] of Object.entries(root)) {
    if (typeof value === 'function') {
      ;(root as Record<string, unknown>)[key] = function (this: unknown, ...a: unknown[]) {
        seen.push(path + key)
        return value.apply(this, a)
      }
    } else if (value !== null && typeof value === 'object') record(value, seen, `${path}${key}.`, done)
  }
}

test('start builds the text from the live trackers that opted in', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.m.compose({ traits: [] }, [])).toEqual([{ id: PROMPT_SECTION_ID, text: framed('a: one'), scope: 'session' }])
  expect(t.calls).toEqual({ a: 1, b: 0 }) // b has not opted in: its view is never read
})

test('a lazy start builds the text too', async () => {
  const t = setup()
  await t.m.ensureStarted(t.w.ports)
  expect(t.text()).toBe(framed('a: one'))
})

test('a tracker that is off in the config adds no lines', async () => {
  const t = setup({ trackers: { a: { enabled: false, prompt: { enabled: true } } } })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.sections()).toEqual([])
  expect(t.calls.a).toBe(0)
})

test('a tracker with no prompt() and a tracker with prompt off are not asked', async () => {
  const t = setup({ trackers: { plain: { prompt: { enabled: true } }, b: { prompt: { enabled: false } } } })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.sections()).toEqual([])
  expect(t.calls).toEqual({ a: 0, b: 0 })
})

test('the trackers contribute in their order', async () => {
  const t = setup(BOTH_ON)
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.text()).toBe(framed('a: one', 'b: one'))
})

test('compose touches no port', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const seen: string[] = []
  const logs = t.w.logs.length
  record(t.w.ports, seen)
  for (let i = 0; i < 3; i++) t.m.compose({ traits: [] }, [])
  t.m.compose({ traits: ['analysis'] }, [])
  expect(seen).toEqual([])
  expect(t.w.logs.length).toBe(logs)
  // The recorder does see a port call, so an empty record means something.
  await t.w.ports.session.id()
  expect(seen).toEqual(['session.id'])
})

test('a main-loop turnComplete rebuilds; a subagent turnComplete does not', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  t.state.a = ['a: two']
  await t.m.turnComplete(t.w.ports, MAIN)
  expect(t.text()).toBe(framed('a: two'))
  t.state.a = ['a: three']
  await t.m.turnComplete(t.w.ports, SUBAGENT)
  expect(t.text()).toBe(framed('a: two'))
  await t.m.turnComplete(t.w.ports, MAIN)
  expect(t.text()).toBe(framed('a: three'))
})

test('an empty agent id or an input that is no record counts as the main loop', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  t.state.a = ['a: two']
  await t.m.turnComplete(t.w.ports, { input: { agentId: '', reason: 'answer' } })
  expect(t.text()).toBe(framed('a: two'))
  t.state.a = ['a: three']
  await t.m.turnComplete(t.w.ports, { input: null })
  expect(t.text()).toBe(framed('a: three'))
})

test('a data change alone does not change the text (S2)', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const before = t.text()
  const asked = t.calls.a
  t.state.a = ['a: changed']
  await t.m.entry(t.w.ports)
  await t.w.clock.advance(120_000) // a few ticks
  expect(t.text()).toBe(before)
  expect(t.calls.a).toBe(asked)
})

test('an idle boundary keeps the same text (S2)', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const before = t.text()
  const asked = t.calls.a
  const rebuilt = t.logged('prompt:').length
  await t.m.turnComplete(t.w.ports, MAIN)
  expect(t.text()).toBe(before)
  expect(t.calls.a).toBe(asked + 1)
  expect(t.logged('prompt:').length).toBe(rebuilt) // an unchanged text logs nothing
})

test('session.end drops the text; the switch rebuilds from the new session (S12)', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.text()).toBe(framed('a: one'))
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(t.sections()).toEqual([])
  t.state.a = ['a: new']
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.text()).toBe(framed('a: new'))
})

test('a config change seen by refreshConfig rebuilds at once', async () => {
  const t = setup({})
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.sections()).toEqual([])
  t.fake.set(A_ON)
  expect(await t.m.refreshConfig(t.w.ports)).toBe(true)
  expect(t.text()).toBe(framed('a: one'))
  t.fake.set({ trackers: { a: { prompt: { enabled: false } } } })
  expect(await t.m.refreshConfig(t.w.ports)).toBe(true)
  expect(t.sections()).toEqual([])
})

test('a refresh that finds no change rebuilds nothing', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const asked = t.calls.a
  expect(await t.m.refreshConfig(t.w.ports)).toBe(false)
  expect(t.calls.a).toBe(asked)
})

test('the tick sees a config change and rebuilds', async () => {
  const t = setup({})
  await t.m.start(t.w.ports, { fromSessionStart: true })
  t.fake.set(A_ON)
  await t.w.clock.advance(31_000)
  expect(t.text()).toBe(framed('a: one'))
})

test('maxItems from the config applies at the next rebuild', async () => {
  const t = setup({ trackers: { a: { prompt: { enabled: true, maxItems: 5 } } } })
  t.state.a = Array.from({ length: 12 }, (_, i) => `a: item ${i + 1}`)
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.text()).toBe(framed('a: item 1', 'a: item 2', 'a: item 3', 'a: item 4', 'a: and 8 more not listed'))
  t.fake.set({ trackers: { a: { prompt: { enabled: true, maxItems: 50 } } } })
  await t.m.refreshConfig(t.w.ports)
  expect(t.text()?.split('\n').length).toBe(13)
})

test('a throwing prompt skips that tracker and logs once', async () => {
  const t = setup(BOTH_ON)
  t.state.boom = 'boom'
  t.state.b = ['b: two']
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.text()).toBe(framed('b: two'))
  expect(t.w.logs.filter(l => l.includes('boom'))).toEqual(['prompt: a failed: boom'])
})

test('a throwing view builder keeps the old text and the next boundary retries', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const real = t.m.viewsOf
  let fail = true
  Object.assign(t.m, {
    viewsOf: async (...a: Parameters<typeof real>) => {
      if (!fail) return real(...a)
      fail = false
      throw new Error('read refused')
    },
  })
  t.state.a = ['a: two']
  await t.m.turnComplete(t.w.ports, MAIN) // no throw reaches the caller
  expect(t.text()).toBe(framed('a: one'))
  expect(t.logged('prompt: rebuild failed')).toEqual(['prompt: rebuild failed: read refused'])
  await t.m.turnComplete(t.w.ports, MAIN)
  expect(t.text()).toBe(framed('a: two'))
})

test('compose never throws: a failure returns the list it was given and logs once', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const list: readonly PromptSection[] = [{ id: 'intro', text: 'engine intro', scope: 'shared' }]
  expect(t.m.compose(null as never, list)).toBe(list)
  expect(t.logged('prompt: compose failed')).toHaveLength(1)
})

test('a hot reload builds a new manager with no text until its own start', async () => {
  const old = setup()
  await old.m.start(old.w.ports, { fromSessionStart: true })
  const next = setup()
  expect(next.sections()).toEqual([])
  await next.m.start(next.w.ports, { fromSessionStart: true })
  expect(next.text()).toBe(framed('a: one'))
})

// ---------------------------------------------------------------- the real trackers

const WEB_ON = { trackers: { web: { prompt: { enabled: true } } } }
const ALL_ON = {
  trackers: Object.fromEntries(
    ['github', 'jira', 'web', 'artifact', 'file'].map(id => [id, { prompt: { enabled: true } }]),
  ),
}

/** The real trackers over this config file, started, with one web link tracked and one turn ended. */
async function realWorld(file: JsonObject = WEB_ON) {
  const t = managerWorld({ config: specs => fakeConfig({ specs, file }) })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  await t.m.row(t.w.ports, promptRow('see https://docs.example/a'))
  await t.m.turnComplete(t.w.ports, MAIN)
  const has = (): boolean =>
    (t.m.compose({ traits: [] }, []).find(s => s.id === PROMPT_SECTION_ID)?.text ?? '').includes('docs.example/a')
  return { t, has }
}

test('a dismiss drops the item from the text at once, with no turn between', async () => {
  const { t, has } = await realWorld()
  expect(has()).toBe(true)
  await t.m.dismiss(t.w.ports, t.keys())
  expect(has()).toBe(false)
})

/** Two web links in the order of the first sight, a then b, and the order of the lines of the text. */
async function twoLinks() {
  const { t } = await realWorld()
  await t.m.row(t.w.ports, promptRow('and https://docs.example/b'))
  await t.m.turnComplete(t.w.ports, MAIN)
  const order = (): string[] =>
    (t.m.compose({ traits: [] }, []).find(s => s.id === PROMPT_SECTION_ID)?.text ?? '')
      .split('\n')
      .flatMap(line => /docs\.example\/(\w)/.exec(line)?.[1] ?? [])
  return { t, order }
}

test('a priority mark from the pane reorders the text at once, with no turn between (review of L7)', async () => {
  const { t, order } = await twoLinks()
  expect(order()).toEqual(['a', 'b'])
  await t.m.setPriority(t.w.ports, 'web:https://docs.example/b', 'high')
  expect(order()).toEqual(['b', 'a'])
  await t.m.setPriority(t.w.ports, 'web:https://docs.example/b', undefined)
  expect(order()).toEqual(['a', 'b'])
})

test('/track prio reorders the text at once, with no turn between (review of L7)', async () => {
  const { t, order } = await twoLinks()
  expect(order()).toEqual(['a', 'b'])
  await t.m.track(t.w.ports, 'prio https://docs.example/b high')
  expect(order()).toEqual(['b', 'a'])
})

test('/track clear drops the items from the text at once, with no turn between', async () => {
  const { t, has } = await realWorld()
  expect(has()).toBe(true)
  await t.m.clear(t.w.ports)
  expect(has()).toBe(false)
  expect(t.m.compose({ traits: [] }, [])).toEqual([])
})

test('a rebuild reads the state once, however many trackers are on', async () => {
  const reads = async (file: JsonObject): Promise<number> => {
    const { t } = await realWorld(file)
    const seen: string[] = []
    record(t.w.ports, seen)
    await t.m.turnComplete(t.w.ports, MAIN)
    return seen.filter(s => s === 'state.items.get').length
  }
  const one = await reads(WEB_ON)
  expect(one).toBeGreaterThan(0)
  expect(await reads(ALL_ON)).toBe(one)
})

test('a rebuild with every prompt key off reads no view', async () => {
  const t = managerWorld({ config: specs => fakeConfig({ specs, file: {} }) })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  const views: string[] = []
  const real = t.m.viewsOf
  Object.assign(t.m, {
    viewsOf: (...a: Parameters<typeof real>) => {
      views.push('read')
      return real(...a)
    },
  })
  await t.m.turnComplete(t.w.ports, MAIN)
  expect(views).toEqual([])
})

// ---------------------------------------------------------------- a change that comes during a build (review of L7)

/**
 * Holds the first build after it has read the state, for 20 ms of real time. A change that comes in that window is
 * newer than what the build read. Resolves when the build holds. Everything between is microtasks, so 20 ms is long
 * enough: a timer that fires early makes a test pass, never fail.
 */
function holdFirstRead(m: LifecycleManager): Promise<void> {
  const real = m.viewsOf
  let reached!: () => void
  const held = new Promise<void>(resolve => {
    reached = resolve
  })
  let first = true
  Object.assign(m, {
    viewsOf: async (...a: Parameters<typeof real>) => {
      const views = await real(...a)
      if (first) {
        first = false
        reached()
        await sleep(20)
      }
      return views
    },
  })
  return held
}

test('a dismiss during a build reaches the text (review of L7)', async () => {
  const { t, has } = await realWorld()
  const held = holdFirstRead(t.m)
  const turn = t.m.turnComplete(t.w.ports, MAIN) // a build starts and reads the state
  await held
  await t.m.dismiss(t.w.ports, t.keys()) // the person's x comes after the read
  await turn
  expect(has()).toBe(false)
})

test('a priority mark during a build reaches the text (review of L7)', async () => {
  const { t, order } = await twoLinks()
  const held = holdFirstRead(t.m)
  const turn = t.m.turnComplete(t.w.ports, MAIN)
  await held
  await t.m.setPriority(t.w.ports, 'web:https://docs.example/b', 'high')
  await turn
  expect(order()).toEqual(['b', 'a'])
})

test('/track clear during a build reaches the text (review of L7)', async () => {
  const { t } = await realWorld()
  const held = holdFirstRead(t.m)
  const turn = t.m.turnComplete(t.w.ports, MAIN)
  await held
  await t.m.clear(t.w.ports)
  await turn
  expect(t.m.compose({ traits: [] }, [])).toEqual([])
})

test('a config change during a build reaches the text (review of L7)', async () => {
  const t = setup({ trackers: { a: { prompt: { enabled: true, maxItems: 5 } } } })
  t.state.a = Array.from({ length: 12 }, (_, i) => `a: item ${i + 1}`)
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.text()?.split('\n').length).toBe(6) // the frame, four lines and "and 8 more"
  const held = holdFirstRead(t.m)
  const turn = t.m.turnComplete(t.w.ports, MAIN) // a build starts and reads maxItems 5
  await held
  t.fake.set({ trackers: { a: { prompt: { enabled: true, maxItems: 50 } } } })
  expect(await t.m.refreshConfig(t.w.ports)).toBe(true) // the one change notification
  await turn
  expect(t.text()?.split('\n').length).toBe(13)
})

// ---------------------------------------------------------------- what a web link shows (review of L7)

const textOf = (t: Awaited<ReturnType<typeof realWorld>>['t']): string =>
  t.m.compose({ traits: [] }, []).find(s => s.id === PROMPT_SECTION_ID)?.text ?? ''

test('a web link that URL rejects reaches the text with no userinfo, query or fragment', async () => {
  const { t } = await realWorld()
  await t.m.row(t.w.ports, promptRow('see https://u:tok@localhost:99999/cb?token=secret#frag')) // the port is out of range
  await t.m.turnComplete(t.w.ports, MAIN)
  expect(textOf(t)).toContain('web: https://localhost:99999/cb')
  expect(textOf(t)).not.toMatch(/secret|tok@|frag/)
})

test('a file: or mailto: link is no web item: the text lists none', async () => {
  const { t } = await realWorld()
  await t.m.row(t.w.ports, promptRow('see [r](file:///tmp/report?token=secret) and [m](mailto:u@e.com?body=secret)'))
  await t.m.turnComplete(t.w.ports, MAIN)
  expect(textOf(t)).not.toMatch(/file:|mailto:|secret/)
})

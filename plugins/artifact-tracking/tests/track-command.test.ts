// `/track` on fakePorts, through a real LifecycleManager and item service: the empty command, refresh, clear, prio and
// the usage line. Each case mirrors the kit test of the same subject in register.test.tsx. Plan: L3 Task 12.
import { expect, test } from 'claude-code/testing'
import type { Tracker } from '../core/interfaces/tracker'
import { trackCommand } from '../hooks/command'
import { fakeItems, promptRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

const USAGE = 'Usage: /track [refresh|clear|prio <ref> <high|normal|low|auto>]'

/** A tracker that writes the commands it hears to `log`, with the number of items at that moment. */
function recorder(log: string[], count: () => number): Tracker {
  return {
    id: 'recorder',
    order: 5,
    config: { defaults: { enabled: true }, normalise: (_raw, defaults) => defaults },
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { command: (_ctx, ev) => void log.push(`command:${ev.sub || '-'}:${ev.wait}:${count()}`) },
  }
}

function world() {
  const log: string[] = []
  const w = managerWorld({ extra: [recorder(log, () => w.keys().length)] })
  const run = (args: string) => trackCommand(w.w.ports, w.m, w.rt, args)
  const see = (text: string) => w.m.row(w.w.ports, promptRow(text))
  return { ...w, log, run, see }
}

test('the empty command opens the pane, runs the tracker commands and prints the text', async () => {
  const t = world()
  expect((await t.run('')).text).toBe('No tracked items yet.')
  expect(t.w.ui.opened).toBe(1)
  expect(t.w.ui.toasts).toEqual([])
  expect(t.log).toEqual(['command:-:true:0'])
  await t.see('look at https://docs.example/a')
  expect((await t.run('')).text).toContain('docs.example/a')
  expect(t.w.calls.filter(c => c[0] === 'gh' && c[1] === '--version').length).toBe(1) // the probes are cached
})

test('the empty command toasts when the pane has no room, and still prints the text', async () => {
  const t = world()
  t.w.ui.placed = false
  expect((await t.run('')).text).toBe('No tracked items yet.')
  expect(t.w.ui.toasts).toEqual(['Widen the terminal to see the tracking pane'])
})

test('refresh refreshes the items, then runs the tracker commands', async () => {
  const t = world()
  const order: string[] = []
  const refreshAll = t.rt.refreshAll.bind(t.rt)
  t.rt.refreshAll = async () => {
    order.push('items')
    await refreshAll()
    order.push('items done')
  }
  await t.see('https://github.com/acme/web/issues/9')
  t.log.length = 0
  const out = await t.run('refresh')
  expect(order).toEqual(['items', 'items done'])
  expect(t.log).toEqual(['command:refresh:true:1']) // after the items were refreshed, with the item still listed
  expect(out.text).toContain('#9')
})

test('clear runs the tracker commands, then clears the list and the stored copy', async () => {
  const t = world()
  await t.see('look at https://docs.example/a')
  await t.w.clock.advance(1600) // the flush writes the stored copy
  expect(t.w.store.has('v2:s:sess-1')).toBe(true)
  const out = await t.run('clear')
  expect(out.text).toBe('Tracking list cleared.')
  expect(t.log).toEqual(['command:clear:true:1']) // the trackers hear it while the list is still there
  expect(t.keys()).toEqual([])
  expect(t.w.store.has('v2:s:sess-1')).toBe(false)
})

test('prio sets a level by ref and saves it before the reply', async () => {
  const t = world()
  await t.see('see https://github.com/acme/web/issues/9')
  expect(t.w.store.has('v2:s:sess-1')).toBe(false) // the flush is 1.5 s away
  const out = await t.run('prio #9 high')
  expect(out.text).toContain('#9')
  const copy = t.w.store.get('v2:s:sess-1') as unknown as { items: { priority?: string }[] }
  expect(copy.items[0]?.priority).toBe('high') // flushed now, no clock advance
  await t.run('PRIO #9 auto')
  expect((t.items()[0] as { priority?: string }).priority).toBeUndefined()
})

test('prio of an untracked ref says Not tracked', async () => {
  const t = world()
  expect((await t.run('prio #99 high')).text).toBe('Not tracked: #99')
})

test('a bad level or a bogus argument prints the usage', async () => {
  const t = world()
  await t.see('see https://github.com/acme/web/issues/9')
  for (const args of ['prio #9 urgent', 'prio #9', 'bogus', 'refresh now']) expect((await t.run(args)).text).toBe(USAGE)
  expect((t.items()[0] as { priority?: string }).priority).toBeUndefined()
})

test('an item host that never started says it is not ready', async () => {
  const t = world()
  const idle = fakeItems().items
  expect((await trackCommand(t.w.ports, t.m, idle, '')).text).toBe('artifact-tracking: not ready.')
  expect(t.w.ui.opened).toBe(0)
})

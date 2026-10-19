// The pane's write callbacks on fakePorts, through a real LifecycleManager and item service: fold, refresh, dismiss,
// focus and the priority keys, and the rules that pick the row a key acts on. Plan: L3 Task 12.
import { expect, test } from 'claude-code/testing'
import type { Tracker } from '../core/interfaces/tracker'
import { type PaneFocus, paneActions, pickRow } from '../hooks/pane-actions'
import { composePane } from '../hooks/ui/auto-view'
import { markKeys } from '../hooks/ui/view'
import { viewInputs } from '../hooks/view-inputs'
import { promptRow, sleep, until } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

function world() {
  const log: string[] = []
  const recorder: Tracker = {
    id: 'recorder',
    order: 5,
    config: { defaults: { enabled: true }, normalise: (_raw, defaults) => defaults },
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { command: (_ctx, ev) => void log.push(`command:${ev.sub}:${ev.wait}`) },
  }
  const w = managerWorld({ extra: [recorder] })
  const focus: PaneFocus = { row: undefined, rows: new Map() }
  const actions = paneActions(w.w.ports, w.m, w.rt, focus)
  const see = (text: string) => w.m.row(w.w.ports, promptRow(text))
  const marks = async () => {
    const v = await viewInputs(w.w.ports, w.m.facts, {})
    return markKeys(composePane(v.items, v.processes, v.processUi, v.ctx, v.repos))
  }
  return { ...w, log, focus, actions, see, marks }
}

const GH9 = 'see https://github.com/acme/web/issues/9'
const folded = (t: ReturnType<typeof world>) =>
  (t.w.state.get('ui') as unknown as { folded: string[] } | undefined)?.folded

test('fold toggles the id in ui.folded', async () => {
  const t = world()
  t.actions.fold('gh:x')
  await until(() => folded(t)?.includes('gh:x') === true, 'the fold')
  t.actions.fold('gh:y')
  await until(() => folded(t)?.length === 2, 'the second fold')
  t.actions.fold('gh:x')
  await until(() => folded(t)?.length === 1, 'the unfold')
  expect(folded(t)).toEqual(['gh:y'])
})

test('dismiss goes to the manager: the key leaves the list and joins the dismiss list', async () => {
  const t = world()
  await t.see('look at https://docs.example/a')
  expect(t.keys()).toEqual(['web:https://docs.example/a'])
  t.actions.dismiss('web:https://docs.example/a')
  await until(() => t.keys().length === 0, 'the dismissed row to leave')
  expect((t.w.state.get('auto') as unknown as { dismissed: string[] }).dismissed).toContain(
    'web:https://docs.example/a',
  )
})

test('a dismiss that fails leaves the row and does not throw', async () => {
  const t = world()
  await t.see('look at https://docs.example/a')
  t.w.ports.state.slot.update = async () => {
    throw new Error('refused')
  }
  t.actions.dismiss('web:https://docs.example/a')
  await sleep(20)
  expect(t.keys()).toEqual(['web:https://docs.example/a'])
})

test('refresh starts the item host, kicks a manual refresh, then tells the trackers with no wait', async () => {
  const t = world()
  const kicks: string[] = []
  const kick = t.rt.kick.bind(t.rt)
  t.rt.kick = reason => {
    kicks.push(`kick:${reason}:${t.log.length}`) // how many tracker commands were heard before the kick
    kick(reason)
  }
  t.actions.refresh()
  await until(() => t.log.length > 0, 'the manual command')
  expect(kicks).toEqual(['kick:manual:0'])
  expect(t.log).toEqual(['command:manual:false'])
  expect(t.rt.ready).toBe(true)
})

test('focus picks the row the priority keys act on', () => {
  const t = world()
  t.actions.focus('gh:row')
  expect(t.focus.row).toBe('gh:row')
})

test('prioritize with no picked row does nothing', async () => {
  const t = world()
  await t.see(GH9)
  t.actions.prioritize('high')
  await sleep(20)
  expect((t.items()[0] as { priority?: string }).priority).toBeUndefined()
  expect(t.w.ui.focused).toEqual([])
})

test('prioritize moves the ring to the new mark key and survives a refused focus', async () => {
  const t = world()
  await t.see(GH9)
  const [id] = [...(await t.marks()).keys()]
  expect(id).toBeDefined()
  t.focus.row = id
  t.actions.prioritize('high')
  await until(() => t.w.ui.focused.length === 1, 'the ring to move')
  expect((t.items()[0] as { priority?: string }).priority).toBe('high')
  expect(t.w.ui.focused[0]).toBe((await t.marks()).get(id!))
  expect(t.w.ui.focused[0]).toContain(':high:')
  t.w.ports.ui.focus = async () => {
    throw new Error('refused')
  }
  t.actions.prioritize(undefined) // `0` removes the mark; the move is refused and nothing throws
  await until(() => (t.items()[0] as { priority?: string }).priority === undefined, 'the mark to go')
  await sleep(20)
  expect(t.w.ui.focused.length).toBe(1)
})

test('pickRow: a mark, fold or x Button picks its row; a footer key keeps the pick; another Button drops it', () => {
  const focus: PaneFocus = { row: undefined, rows: new Map([['mark:0:-:gh:a', 'gh:a']]) }
  pickRow(focus, { element: 'mark:0:-:gh:a' })
  expect(focus.row).toBe('gh:a')
  pickRow(focus, { element: 'prio-1' }) // the footer key: the pick stays
  expect(focus.row).toBe('gh:a')
  pickRow(focus, { element: 'refresh' }) // another Button
  expect(focus.row).toBeUndefined()
})

test('pickRow: an engine stop keeps the pick; a person moving the ring with no element drops it', () => {
  const focus: PaneFocus = { row: 'gh:a', rows: new Map() }
  pickRow(focus, { origin: { kind: 'engine' } })
  expect(focus.row).toBe('gh:a')
  pickRow(focus, {})
  expect(focus.row).toBe('gh:a')
  pickRow(focus, { origin: { kind: 'person' } })
  expect(focus.row).toBeUndefined()
})

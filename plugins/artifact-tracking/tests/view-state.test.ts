// The view of the pane as session state (issue #63, L3): the atom `view`, the atom `filters`, `global.ui.view` and
// `/track view <name>`. A view is never written to the config file or the store. The world is the whole pane world.
import { expect, test } from 'claude-code/testing'
import { listText, paneGroups, paneModel, TEXT_VIEW } from '../hooks/pane-text'
import { paneWorld } from './fixtures/pane-world'

const VIEW_USAGE = 'Usage: /track view <list|tracker|status|reason|flat>'
const firstLine = (text: string): string => text.split('\n')[0] ?? ''

test('with no choice the pane takes global.ui.view: list by default, the configured view otherwise', async () => {
  const plain = await paneWorld()
  const model = await paneModel(plain.w.ports, plain.m, TEXT_VIEW)
  expect(model.view).toBe('list')
  expect(model.groups.map(g => g.id).filter(id => id.startsWith('list:'))).toContain('list:prs')
  const set = await paneWorld({ global: { ui: { view: 'status' } } })
  expect((await paneModel(set.w.ports, set.m, TEXT_VIEW)).view).toBe('status')
  expect((await paneGroups(set.w.ports, set.m, TEXT_VIEW)).map(g => g.id)).toContain('status:failed')
})

test('a view the person chose wins over global.ui.view; a value that is no view reads as no choice', async () => {
  const t = await paneWorld({ global: { ui: { view: 'status' } } })
  await t.w.ports.state.view.update(() => 'flat')
  expect((await paneModel(t.w.ports, t.m, TEXT_VIEW)).view).toBe('flat')
  await t.w.ports.state.view.update(() => 'nonsense')
  expect((await paneModel(t.w.ports, t.m, TEXT_VIEW)).view).toBe('status')
  await t.w.ports.state.view.update(() => null)
  expect((await paneModel(t.w.ports, t.m, TEXT_VIEW)).view).toBe('status')
})

test('/clear resets the view: the engine drops the atom and the pane is back on global.ui.view', async () => {
  const t = await paneWorld({ global: { ui: { view: 'tracker' } } })
  await t.m.track(t.w.ports, 'view flat')
  expect((await paneModel(t.w.ports, t.m, TEXT_VIEW)).view).toBe('flat')
  t.w.state.delete('view') // what the engine does to `$.state` at /clear
  expect((await paneModel(t.w.ports, t.m, TEXT_VIEW)).view).toBe('tracker')
})

test('/track view <name> sets the session view, prints the list in it with View: <name> first, and redraws the pane', async () => {
  const t = await paneWorld()
  const drawn = t.w.ui.invalidated
  const out = await t.m.track(t.w.ports, 'view status')
  expect(t.w.state.get('view')).toBe('status')
  expect(firstLine(out.text)).toBe('View: status')
  expect(out.text).toContain('\nFailed\n') // a group of a view has no note: the title line ends at the title
  expect(t.w.ui.invalidated - drawn).toBe(1)
  // The text of the by-list view says the view too, so the person sees that the reply is the list.
  const list = await t.m.track(t.w.ports, 'view list')
  expect(firstLine(list.text)).toBe('View: list')
  expect(list.text).toContain('\nPull requests ')
})

test('/track view takes the name in any case, with spaces around', async () => {
  const t = await paneWorld()
  expect(firstLine((await t.m.track(t.w.ports, '  View   REASON ')).text)).toBe('View: reason')
  expect(t.w.state.get('view')).toBe('reason')
})

test('an unknown view name, and no name, print the usage with the view names and set nothing', async () => {
  const t = await paneWorld()
  for (const args of ['view', 'view type', 'view status flat', 'view toString']) {
    expect((await t.m.track(t.w.ports, args)).text).toBe(VIEW_USAGE)
  }
  expect(t.w.state.get('view')).toBeUndefined()
})

test('a view and a filter live in session atoms: no config file write, no store key', async () => {
  const t = await paneWorld()
  await t.m.track(t.w.ports, '') // the first /track makes the first store write: let it happen
  await t.w.clock.advance(5000)
  const files = { ...t.w.files }
  const sets = t.w.storeSets
  await t.m.track(t.w.ports, 'view reason')
  await t.w.ports.state.filters.update(() => ({ touchedOnly: true }))
  await t.w.clock.advance(5000) // past the flush delay of the stored copy
  expect(t.w.files).toEqual(files)
  expect(t.w.storeSets).toBe(sets)
})

test('/track prints a View line first when the view is not list or a filter is on, and nothing more in the default', async () => {
  const t = await paneWorld()
  const plain = await listText(t.w.ports, t.m)
  expect(plain.startsWith('View:')).toBe(false)
  await t.w.ports.state.filters.update(() => ({ touchedOnly: true }))
  const touched = await listText(t.w.ports, t.m)
  expect(firstLine(touched)).toMatch(/^View: list · touched only · \d+ hidden$/)
  await t.w.ports.state.view.update(() => 'flat')
  expect(firstLine(await listText(t.w.ports, t.m))).toMatch(/^View: flat · touched only · \d+ hidden$/)
  await t.w.ports.state.filters.update(() => ({ touchedOnly: false }))
  expect(firstLine(await listText(t.w.ports, t.m))).toBe('View: flat')
  await t.w.ports.state.hidden.update(() => ({ showAll: true }))
  expect(firstLine(await listText(t.w.ports, t.m))).toBe('View: flat · showing all')
})

test('touched only hides the rows that were discovered or mentioned, in the pane data and in the count', async () => {
  const t = await paneWorld()
  await t.w.ports.state.view.update(() => 'flat') // every row is a top-level row: the counts match exactly
  const before = await paneModel(t.w.ports, t.m, TEXT_VIEW)
  expect(before.hidden).toBe(0)
  await t.w.ports.state.filters.update(() => ({ touchedOnly: true }))
  const after = await paneModel(t.w.ports, t.m, TEXT_VIEW)
  expect(after.touchedOnly).toBe(true)
  expect(after.hidden).toBeGreaterThan(0)
  const count = (m: typeof before): number => m.groups.reduce((n, g) => n + g.rows.length, 0)
  expect(count(before) - count(after)).toBe(after.hidden)
})

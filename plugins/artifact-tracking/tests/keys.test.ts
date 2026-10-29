// KeyRegistry and the key routing: which keys exist, which are dropped at init, and where a key press goes.
// Pure. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Keys". Plan: L6 Task 6 (G6, G7, G16).
import { expect, test } from 'claude-code/testing'
import {
  bulkTargets,
  buttonKeyOf,
  CORE_KEYS,
  dismissTargets,
  footerKeys,
  KeyRegistry,
  PRIO_LEVEL,
  planFooter,
  previewKeys,
  route,
  viewButtonKeys,
  viewKeys,
} from '../core/infra/keys'
import type { KeySpec } from '../core/interfaces/tracker'
import type { PaneKey, RowRef } from '../core/interfaces/view'
import { TRACKERS } from '../trackers'

const spec = (id: string, key: string, scope: KeySpec['scope'] = 'row'): KeySpec => ({ id, key, label: id, scope })
const ALL = { dismiss: true, priority: true } as const
/** A drawn row of `owner`. Pass `can` explicitly, `undefined` included: an absent flag counts as false. */
const ref = (owner: string, ...can: [RowRef['can']] | []): RowRef => ({
  id: 'row-1',
  owner,
  group: 's',
  can: can.length === 0 ? ALL : can[0],
})
const items = (owner: string) => owner === 'items'
/** One core key by id. */
const core = (id: string) => {
  const k = CORE_KEYS.find(c => c.id === id)
  if (k === undefined) throw new Error(id)
  return k
}

/**
 * The core keys that have a Button in the footer of a row with no preview: all but the view line keys, the key line of the preview
 * and `v`, which a row draws only when its tracker has a preview (issue #57, L2).
 */
const FOOTER_CORE = CORE_KEYS.filter(k => k.bar === undefined && k.id !== 'preview').map(k => k.id)

/** The Button keys of the view line. The help view has no view line, so its footer draws them (issue #200). */
const VIEW_KEYS = ['view', 'show-all', 'touched', 'clean', 'mark', 'quick']

test("core keys are r h, the view line keys g a t p m e, x 1 2 3 0, then v and d of the preview, with today's labels for the footer keys", () => {
  expect(CORE_KEYS.map(k => k.key)).toEqual(['r', 'h', 'g', 'a', 't', 'p', 'm', 'e', 'x', '1', '2', '3', '0', 'v', 'd'])
  expect(CORE_KEYS.map(k => k.label)).toEqual([
    'refresh',
    'help',
    'view',
    'show all',
    'touched', // issue #199, owner decision Q5: the sixth pane key needs the shorter label to keep the compact help view in 11 rows
    'clean plan',
    'mark',
    'quick view',
    'dismiss',
    'high',
    'normal',
    'low',
    'auto',
    'preview',
    'diff',
  ])
  expect(CORE_KEYS.map(k => k.id)).toEqual([
    'refresh',
    'help',
    'view',
    'show-all',
    'touched',
    'clean',
    'mark',
    'quick',
    'dismiss',
    'prio-1',
    'prio-2',
    'prio-3',
    'prio-0',
    'preview',
    'diff',
  ])
  expect(CORE_KEYS.every(k => k.owner === 'core')).toBe(true)
})

test('v is a row key of the footer, d sits on the key line of the preview: neither has a place on the view line (issue #57, L2)', () => {
  expect(core('preview')).toEqual({
    id: 'preview',
    key: 'v',
    label: 'preview',
    scope: 'row',
    owner: 'core',
    mode: 'view',
  })
  expect(core('diff')).toEqual({
    id: 'diff',
    key: 'd',
    label: 'diff',
    scope: 'row',
    owner: 'core',
    bar: 'preview',
    mode: 'diff',
  })
  expect(CORE_KEYS.filter(k => k.bar === 'preview').map(k => k.key)).toEqual(['d'])
  // The view line keeps its six keys: the preview adds none to it.
  expect(CORE_KEYS.filter(k => k.bar === 'view').map(k => k.key)).toEqual(['g', 'a', 't', 'p', 'm', 'e'])
})

test('a tracker cannot take v or d: the keys are taken by core, so a second provider never meets a key that is off (issue #57, L2)', () => {
  const reg = new KeyRegistry()
  reg.add('x', [spec('view', 'v'), spec('diff', 'D')])
  expect(reg.problems()).toEqual([
    'keys: x key "v" (view) is taken by core (preview). The key is off.',
    'keys: x key "d" (diff) is taken by core (diff). The key is off.',
  ])
})

test('g, a, t, p, m and e sit on the view line, so the footer keeps its keys and its rows (issues #63, #138, #199 and #276)', () => {
  const bar = CORE_KEYS.filter(k => k.bar === 'view')
  expect(bar.map(k => k.key)).toEqual(['g', 'a', 't', 'p', 'm', 'e'])
  // `m` acts on the selected row, so it is a row key: its press waits in the chain beside `x` and the digits. `e` works on the
  // whole pane, as `g`, `a`, `t` and `p` do.
  expect(bar.map(k => k.scope)).toEqual(['pane', 'pane', 'pane', 'pane', 'row', 'pane'])
  expect(FOOTER_CORE).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  for (const row of [undefined, ref('a'), ref('items')])
    expect(footerKeys(reg, row, items, false).some(k => ['g', 'a', 't', 'p', 'm', 'e'].includes(k.key))).toBe(false)
})

test('viewButtonKeys: the Button key of each view line key, in registry order, whatever the state', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const buttons = viewButtonKeys(reg)
  expect(buttons).toEqual(['view', 'show-all', 'touched', 'clean', 'mark', 'quick'])
  for (const k of buttons) expect(reg.get(k)?.bar).toBe('view')
  // The pane's own keys carry the same Button keys: the refocus compares the two.
  expect(viewKeys(reg, ref('items'), items, false).map(k => k.buttonKey)).toEqual(buttons)
})

test('viewKeys: the view line keys, each with its label and the Button key the registry finds it by', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const on = viewKeys(reg, ref('items'), items, false)
  expect(on.map(k => [k.key, k.label, k.buttonKey, k.enabled])).toEqual([
    ['g', 'view', 'view', true],
    ['a', 'show all', 'show-all', true],
    ['t', 'touched', 'touched', true],
    ['p', 'clean plan', 'clean', true],
    ['m', 'mark', 'mark', true],
    ['e', 'quick view', 'quick', true],
  ])
  for (const k of on) expect(reg.get(k.buttonKey)?.id).toBe(k.id)
})

test('viewKeys with the selected row: m is live on a row that takes a bulk key, or is marked, else dim; g, a, t, p and e stay live', () => {
  const reg = new KeyRegistry()
  const live = (row: RowRef | undefined, marked = false) =>
    Object.fromEntries(viewKeys(reg, row, items, marked).map(k => [k.key, k.enabled]))
  expect(live(ref('items'))).toEqual({ g: true, a: true, t: true, p: true, m: true, e: true })
  expect(live(ref('repos', { dismiss: true }))).toMatchObject({ m: true })
  expect(live(ref('repos', { priority: true }))).toMatchObject({ m: false }) // a digit needs an item owner
  expect(live(ref('repos', {}))).toEqual({ g: true, a: true, t: true, p: true, m: false, e: true })
  expect(live(ref('repos', {}), true)).toMatchObject({ m: true }) // a marked row can always be unmarked
  expect(live(undefined)).toEqual({ g: true, a: true, t: true, p: true, m: false, e: true })
})

test('a tracker cannot take m: it is a core key', () => {
  const reg = new KeyRegistry()
  reg.add('x', [spec('mark', 'm')])
  expect(reg.problems()).toEqual(['keys: x key "m" (mark) is taken by core (mark). The key is off.'])
})

test('a tracker cannot take g, a, t, p or e: the keys are taken by core', () => {
  const reg = new KeyRegistry()
  reg.add('x', [spec('go', 'g'), spec('all', 'A'), spec('tag', 't'), spec('plan', 'p'), spec('edit', 'e')])
  expect(reg.problems()).toEqual([
    'keys: x key "g" (go) is taken by core (view). The key is off.',
    'keys: x key "a" (all) is taken by core (show-all). The key is off.',
    'keys: x key "t" (tag) is taken by core (touched). The key is off.',
    'keys: x key "p" (plan) is taken by core (clean). The key is off.',
    'keys: x key "e" (edit) is taken by core (quick). The key is off.',
  ])
  expect(reg.get('x.plan')).toBeUndefined()
})

test('route: g, a, t, p and e route at once, with no row, with a tracker row and with a row that takes no key', () => {
  for (const row of [undefined, ref('items'), ref('t', {}), ref('github', undefined)]) {
    expect(route(core('view'), row, items)).toEqual({ to: 'view' })
    expect(route(core('show-all'), row, items)).toEqual({ to: 'showAll' })
    expect(route(core('touched'), row, items)).toEqual({ to: 'touched' })
    expect(route(core('clean'), row, items)).toEqual({ to: 'clean' }) // before the row check: the plan needs no row (issue #199)
    expect(route(core('quick'), row, items)).toEqual({ to: 'quick' })
  }
})

test('a key is folded to lowercase', () => {
  const reg = new KeyRegistry()
  reg.add('t', [spec('open', 'O')])
  expect(reg.get('t.open')?.key).toBe('o')
  expect(reg.problems()).toEqual([])
})

test('an invalid key is dropped with a problem', () => {
  const reg = new KeyRegistry()
  reg.add('t', [spec('a', 'ab'), spec('b', '?'), spec('c', '')])
  expect(reg.problems()).toEqual([
    'keys: t key "ab" (a) is not one letter a-z or one digit 0-9. The key is off.',
    'keys: t key "?" (b) is not one letter a-z or one digit 0-9. The key is off.',
    'keys: t key "" (c) is not one letter a-z or one digit 0-9. The key is off.',
  ])
  expect(reg.get('t.a')).toBeUndefined()
  expect(reg.get('t.b')).toBeUndefined()
  expect(reg.all()).toEqual(CORE_KEYS)
})

test('a duplicate key is dropped with a problem naming the first owner', () => {
  const reg = new KeyRegistry()
  reg.add('t', [spec('kill', 'X')])
  expect(reg.problems()).toEqual(['keys: t key "x" (kill) is taken by core (dismiss). The key is off.'])
  expect(reg.get('t.kill')).toBeUndefined()
})

test('a key taken by an earlier tracker names that tracker', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  reg.add('b', [spec('other', 'O')])
  expect(reg.problems()).toEqual(['keys: b key "o" (other) is taken by a (open). The key is off.'])
  expect(reg.all().map(buttonKeyOf)).toEqual([...CORE_KEYS.map(k => k.id), 'a.open'])
})

test('a repeated key id of one owner is dropped, so a footer Button key stays unique', () => {
  const reg = new KeyRegistry()
  reg.add('t', [spec('open', 'o'), spec('open', 'q')])
  expect(reg.get('t.open')?.key).toBe('o')
  expect(reg.problems()).toEqual(['keys: t key "q" (open) repeats the key id "open" of t. The key is off.'])
  expect(reg.all().filter(k => k.owner === 't')).toHaveLength(1)
})

test('all lists core first, then the added keys in add order', () => {
  const reg = new KeyRegistry()
  reg.add('b', [spec('two', '8')])
  reg.add('a', [spec('one', '9'), spec('three', '7')])
  expect(reg.all().map(buttonKeyOf)).toEqual([...CORE_KEYS.map(k => k.id), 'b.two', 'a.one', 'a.three'])
})

test('the shipped trackers add no key and no problem', () => {
  const reg = new KeyRegistry()
  for (const t of TRACKERS) reg.add(t.id, t.keys ?? [])
  const keys = reg.all().map(k => k.key)
  expect(new Set(keys).size).toBe(keys.length)
  expect(reg.problems()).toEqual([])
})

test('get finds a key by its footer Button key', () => {
  const reg = new KeyRegistry()
  expect(reg.get('prio-1')?.key).toBe('1')
  expect(reg.get('nope')).toBeUndefined()
})

test('buttonKeyOf: a core key is its id, a tracker key is owner.id', () => {
  expect(buttonKeyOf(core('refresh'))).toBe('refresh')
  expect(buttonKeyOf({ id: 'open', key: 'o', label: 'open', scope: 'row', owner: 'github' })).toBe('github.open')
})

test('PRIO_LEVEL maps the four priority keys', () => {
  expect(PRIO_LEVEL['prio-1']).toBe('high')
  expect(PRIO_LEVEL['prio-2']).toBe('normal')
  expect(PRIO_LEVEL['prio-3']).toBe('low')
  expect(PRIO_LEVEL['prio-0']).toBeUndefined()
  expect(Object.keys(PRIO_LEVEL)).toEqual(['prio-1', 'prio-2', 'prio-3', 'prio-0'])
})

test('route: refresh and help route with no row', () => {
  expect(route(core('refresh'), undefined, items)).toEqual({ to: 'refresh' })
  expect(route(core('help'), undefined, items)).toEqual({ to: 'help' })
})

test('route: x needs a selected row with can.dismiss true', () => {
  expect(route(core('dismiss'), undefined, items)).toEqual({ to: 'none' })
  expect(route(core('dismiss'), ref('t', { dismiss: true }), items)).toEqual({ to: 'dismiss', rowId: 'row-1' })
  expect(route(core('dismiss'), ref('t', {}), items)).toEqual({ to: 'none' })
  expect(route(core('dismiss'), ref('t', undefined), items)).toEqual({ to: 'none' })
  expect(route(core('dismiss'), ref('t', { dismiss: false }), items)).toEqual({ to: 'none' })
})

test('route: x on a row of a tracker with no items still dismisses (the owner hears the event)', () => {
  expect(route(core('dismiss'), ref('repos', { dismiss: true }), items)).toEqual({ to: 'dismiss', rowId: 'row-1' })
})

test('route: 0-3 need an item owner and can.priority', () => {
  expect(route(core('prio-1'), ref('items'), items)).toEqual({ to: 'priority', rowId: 'row-1', level: 'high' })
  expect(route(core('prio-2'), ref('items'), items)).toEqual({ to: 'priority', rowId: 'row-1', level: 'normal' })
  expect(route(core('prio-3'), ref('items'), items)).toEqual({ to: 'priority', rowId: 'row-1', level: 'low' })
  const auto = route(core('prio-0'), ref('items'), items)
  expect(auto).toEqual({ to: 'priority', rowId: 'row-1', level: undefined })
  expect(Object.hasOwn(auto, 'level')).toBe(true)
  expect(route(core('prio-1'), ref('other'), items)).toEqual({ to: 'none' })
  expect(route(core('prio-1'), ref('items', { priority: false }), items)).toEqual({ to: 'none' })
  expect(route(core('prio-1'), ref('items', {}), items)).toEqual({ to: 'none' })
  expect(route(core('prio-1'), undefined, items)).toEqual({ to: 'none' })
})

test('route: m marks a row that can be dismissed, or that takes a priority from an item owner, or that is marked already', () => {
  expect(route(core('mark'), ref('repos', { dismiss: true }), items)).toEqual({ to: 'mark', rowId: 'row-1' })
  expect(route(core('mark'), ref('items', { priority: true }), items)).toEqual({ to: 'mark', rowId: 'row-1' })
  expect(route(core('mark'), ref('repos', { priority: true }), items)).toEqual({ to: 'none' })
  expect(route(core('mark'), ref('repos', {}), items)).toEqual({ to: 'none' })
  expect(route(core('mark'), ref('repos', undefined), items)).toEqual({ to: 'none' })
  expect(route(core('mark'), undefined, items)).toEqual({ to: 'none' })
  expect(route(core('mark'), ref('repos', {}), items, true)).toEqual({ to: 'mark', rowId: 'row-1' })
  expect(route(core('mark'), undefined, items, true)).toEqual({ to: 'none' })
})

test('route: a core key with an unknown id does nothing', () => {
  const odd = { id: 'weird', key: 'w', label: 'weird', scope: 'pane', owner: 'core' } as const
  expect(route(odd, ref('items'), items)).toEqual({ to: 'none' })
})

test('route: a tracker key routes to its owner only while one of its rows is selected', () => {
  const open = { id: 'open', key: 'o', label: 'open', scope: 'row', owner: 'github' } as const
  expect(route(open, ref('github'), items)).toEqual({ to: 'owner', owner: 'github', id: 'open', rowId: 'row-1' })
  expect(route(open, ref('jira'), items)).toEqual({ to: 'none' })
  expect(route(open, undefined, items)).toEqual({ to: 'none' })
})

test("footerKeys: core keys first, then the selected row's owner's keys, with enabled from the route and the state", () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o'), spec('kill', 'k', 'section')])
  reg.add('b', [spec('other', 'q')])
  const keys = footerKeys(reg, ref('a', { dismiss: true }), items, false, (_owner, id) =>
    id === 'kill' ? 'disabled' : 'enabled',
  )
  expect(keys.map(buttonKeyOf)).toEqual([...FOOTER_CORE, 'a.open', 'a.kill'])
  expect(Object.fromEntries(keys.map(k => [buttonKeyOf(k), k.enabled]))).toEqual({
    refresh: true,
    help: true,
    dismiss: true,
    'prio-1': false,
    'prio-2': false,
    'prio-3': false,
    'prio-0': false,
    'a.open': true,
    'a.kill': false,
  })
  expect(keys.find(k => k.id === 'help')?.label).toBe('help')
})

test('footerKeys: with no row only the core keys show, and the row keys are disabled', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const keys = footerKeys(reg, undefined, items, false)
  expect(keys.map(buttonKeyOf)).toEqual(FOOTER_CORE)
  expect(keys.filter(k => k.enabled).map(k => k.key)).toEqual(['r', 'h'])
})

test('footerKeys: an item row enables the priority keys', () => {
  const keys = footerKeys(new KeyRegistry(), ref('items'), items, false)
  expect(keys.every(k => k.enabled)).toBe(true)
})

test('footerKeys in the help view: only r and h are enabled and h is labelled back', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const keys = footerKeys(reg, ref('a'), items, true)
  expect(keys.filter(k => k.enabled).map(k => k.key)).toEqual(['r', 'h'])
  expect(keys.find(k => k.id === 'help')?.label).toBe('back')
  expect(keys.find(k => k.id === 'refresh')?.label).toBe('refresh')
  expect(keys.map(buttonKeyOf)).toEqual([...FOOTER_CORE, 'a.open', ...VIEW_KEYS])
})

test('footerKeys in the help view: the keys of the view line follow 0 as dim Buttons, and the pane footer has none of them', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const help = footerKeys(reg, undefined, items, true)
  expect(help.map(k => k.key)).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'g', 'a', 't', 'p', 'm', 'e']) // the Tab walk from h reaches x
  expect(help.map(k => k.label)).toEqual([
    'refresh',
    'back',
    'dismiss',
    'high',
    'normal',
    'low',
    'auto',
    'view',
    'show all',
    'touched',
    'clean plan',
    'mark',
    'quick view',
  ])
  const viewKeys = help.filter(k => VIEW_KEYS.includes(k.buttonKey))
  expect(viewKeys.map(k => k.buttonKey)).toEqual(VIEW_KEYS)
  expect(viewKeys.every(k => k.enabled === false)).toBe(true)
  expect(help.filter(k => k.enabled).map(k => k.key)).toEqual(['r', 'h'])
  for (const row of [undefined, ref('a'), ref('items')])
    expect(footerKeys(reg, row, items, false).some(k => VIEW_KEYS.includes(k.buttonKey))).toBe(false)
})

test('footerKeys in the help view reads bar: view, not a list of letters: a new key of the view line gets a dim Button', () => {
  const extra: PaneKey = { id: 'export', key: 'l', label: 'export', scope: 'pane', owner: 'core', bar: 'view' }
  const reg = new KeyRegistry([...CORE_KEYS, extra])
  const help = footerKeys(reg, undefined, items, true)
  expect(help.map(buttonKeyOf)).toEqual([...FOOTER_CORE, ...VIEW_KEYS, 'export'])
  expect(help.at(-1)).toMatchObject({ key: 'l', label: 'export', enabled: false, buttonKey: 'export' })
  expect(footerKeys(reg, undefined, items, false).map(buttonKeyOf)).toEqual(FOOTER_CORE) // the pane draws it on the view line
  expect(viewButtonKeys(reg)).toEqual([...VIEW_KEYS, 'export'])
})

test('the help footer holds one Button key per hotkey, and the pane footer and view line together hold one too', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const help = footerKeys(reg, undefined, items, true).map(k => k.key)
  expect(help).toEqual([...new Set(help)])
  const pane = [...footerKeys(reg, ref('a'), items, false), ...viewKeys(reg, ref('a'), items, false)].map(k => k.key)
  expect(pane).toEqual([...new Set(pane)])
})

// Issue #199: the plan view has no view line, so the footer holds a Button for every core key, or `g a t p m` would leave the pane for
// the prompt. Only `p` (back) and `r` (read the plan again) work there. `v` and `d` pick a mode of the preview of a row, and the plan
// view has no row, so they have no Button, as in the help footer (issue #57, L2).
test('planFooter: a Button for every core key but the preview keys, p reads back, r and p are live and the rest are dim', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const keys = planFooter(reg)
  expect(keys.map(buttonKeyOf)).toEqual(CORE_KEYS.filter(k => k.mode === undefined).map(k => k.id)) // no tracker key: no row is selected in a text view
  expect(keys.some(k => k.id === 'preview' || k.id === 'diff')).toBe(false)
  expect(keys.filter(k => k.enabled).map(k => k.key)).toEqual(['r', 'p'])
  expect(keys.find(k => k.id === 'clean')?.label).toBe('back')
  expect(keys.find(k => k.id === 'help')?.label).toBe('help') // dim, and no longer `back`: `h` does nothing here
  expect(keys.find(k => k.id === 'refresh')?.label).toBe('refresh')
  for (const k of keys) expect(reg.get(k.buttonKey)?.id).toBe(k.id)
})

test('planFooter: follows the registry, so a new core key gets a dim Button', () => {
  const keys = planFooter(
    new KeyRegistry([
      ...CORE_KEYS,
      { id: 'extra', key: 'e', label: 'extra', scope: 'pane', owner: 'core', bar: 'view' },
    ]),
  )
  expect(keys.map(k => k.key)).toEqual([...CORE_KEYS.filter(k => k.mode === undefined).map(k => k.key), 'e'])
  expect(keys.at(-1)?.enabled).toBe(false)
})

test('footerKeys: each key carries its footer Button key, the one the registry finds it by', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const keys = footerKeys(reg, ref('a'), items, false)
  expect(keys.map(k => k.buttonKey)).toEqual([...FOOTER_CORE, 'a.open'])
  for (const k of keys) expect(reg.get(k.buttonKey)?.id).toBe(k.id)
})

test('route: v opens the preview of the selected row, for any owner; with no row it does nothing, and d never routes from the list', () => {
  expect(route(core('preview'), ref('file', {}), items)).toEqual({
    to: 'preview',
    rowId: 'row-1',
    owner: 'file',
    mode: 'view',
  })
  expect(route(core('preview'), ref('web', undefined), items)).toEqual({
    to: 'preview',
    rowId: 'row-1',
    owner: 'web',
    mode: 'view',
  })
  expect(route(core('preview'), undefined, items)).toEqual({ to: 'none' })
  for (const row of [undefined, ref('file')]) expect(route(core('diff'), row, items)).toEqual({ to: 'none' })
})

test('footerKeys: v is drawn only for a row whose tracker has a preview, last of the core keys and before the keys of its owner', () => {
  const reg = new KeyRegistry()
  reg.add('file', [spec('open', 'o')])
  reg.add('web', [spec('go', 'w')])
  reg.addPreview('file')
  const file = footerKeys(reg, ref('file'), items, false)
  expect(file.map(k => k.key)).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'v', 'o'])
  expect(file.map(buttonKeyOf)).toEqual([...FOOTER_CORE, 'preview', 'file.open'])
  expect(file.find(k => k.id === 'preview')).toMatchObject({ label: 'preview', enabled: true, buttonKey: 'preview' })
  // A row of a tracker with no preview, and no row at all: no v, and d is on no footer.
  expect(footerKeys(reg, ref('web'), items, false).map(k => k.key)).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'w'])
  expect(footerKeys(reg, undefined, items, false).map(k => k.key)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  for (const row of [undefined, ref('file'), ref('web')])
    expect(footerKeys(reg, row, items, false).some(k => k.key === 'd')).toBe(false)
  // The help view draws it dim: only r and h work there.
  expect(footerKeys(reg, ref('file'), items, true).find(k => k.id === 'preview')?.enabled).toBe(false)
})

test('footerKeys: v is dim for a row that its provider says has no preview, and live for a row that has one (R11)', () => {
  const reg = new KeyRegistry()
  reg.addPreview('file')
  const state = (previewable: boolean) =>
    footerKeys(reg, ref('file'), items, false, undefined, [], previewable).find(k => k.id === 'preview')
  expect(state(true)).toMatchObject({ key: 'v', enabled: true })
  expect(state(false)).toMatchObject({ key: 'v', enabled: false })
  // The default is live: a caller that does not ask the row keeps the rule of the owner.
  expect(footerKeys(reg, ref('file'), items, false).find(k => k.id === 'preview')?.enabled).toBe(true)
  // The answer of the row never changes another key, and a row of an owner with no preview still draws no `v`.
  const others = (previewable: boolean) =>
    footerKeys(reg, ref('file'), items, false, undefined, [], previewable)
      .filter(k => k.id !== 'preview')
      .map(k => [k.id, k.enabled])
  expect(others(false)).toEqual(others(true))
  expect(footerKeys(reg, ref('web'), items, false, undefined, [], false).some(k => k.id === 'preview')).toBe(false)
})

test('hasPreview: the registry knows the owners that addPreview named, and nothing else', () => {
  const reg = new KeyRegistry()
  expect([reg.hasPreview('file'), reg.hasPreview('web')]).toEqual([false, false])
  reg.addPreview('file')
  expect([reg.hasPreview('file'), reg.hasPreview('web')]).toEqual([true, false])
})

const modesOf = (...modes: Array<[id: string, enabled: boolean]>) => modes.map(([id, enabled]) => ({ id, enabled }))

test('the core key that picks a mode names it: v picks view, d picks diff, and no other key picks a mode (issue #57, L2, N275)', () => {
  expect(CORE_KEYS.filter(k => k.mode !== undefined).map(k => [k.key, k.mode])).toEqual([
    ['v', 'view'],
    ['d', 'diff'],
  ])
  // A tracker key never carries a mode: the registry builds it from a `KeySpec`, which has none.
  const reg = new KeyRegistry()
  reg.add('web', [spec('go', 'w')])
  expect(reg.all().filter(k => k.owner === 'web' && k.mode !== undefined)).toEqual([])
})

test('previewKeys: a mode that no core key picks draws no Button, and its neighbours keep theirs (issue #57, L2, N275)', () => {
  const reg = new KeyRegistry()
  // `detail` is the core mode that issue #275 adds: until a key names it, the line has no Button for it.
  expect(previewKeys(reg, modesOf(['detail', true], ['view', true])).map(k => k.key)).toEqual(['v', 'r'])
  expect(previewKeys(reg, modesOf(['detail', true])).map(k => k.key)).toEqual(['r'])
})

test('previewKeys: a mode that a new core key names gets its Button between the modes of the provider, in the order given (issue #275)', () => {
  const detail: PaneKey = {
    id: 'detail',
    key: 'i',
    label: 'detail',
    scope: 'row',
    owner: 'core',
    bar: 'preview',
    mode: 'detail',
  }
  const reg = new KeyRegistry([...CORE_KEYS, detail])
  const keys = previewKeys(reg, modesOf(['view', true], ['detail', true], ['diff', false]))
  expect(keys.map(k => [k.key, k.label, k.buttonKey, k.enabled])).toEqual([
    ['v', 'view', 'preview', true],
    ['i', 'detail', 'detail', true],
    ['d', 'diff', 'diff', false],
    ['r', 'reload', 'refresh', true],
  ])
})

test('previewKeys: one Button for each mode of the row (v, d), then r relabelled reload; a mode that is off draws dim', () => {
  const reg = new KeyRegistry()
  const both = previewKeys(reg, modesOf(['view', true], ['diff', true]))
  expect(both.map(k => [k.key, k.label, k.buttonKey, k.enabled])).toEqual([
    ['v', 'view', 'preview', true],
    ['d', 'diff', 'diff', true],
    ['r', 'reload', 'refresh', true],
  ])
  // The registry finds each key by the Button key: a press on the key line is a press of the core key.
  for (const k of both) expect(reg.get(k.buttonKey)?.key).toBe(k.key)
  expect(previewKeys(reg, modesOf(['view', true])).map(k => k.key)).toEqual(['v', 'r'])
  expect(previewKeys(reg, modesOf(['view', true], ['diff', false])).map(k => [k.key, k.enabled])).toEqual([
    ['v', true],
    ['d', false],
    ['r', true],
  ])
  expect(previewKeys(reg, []).map(k => k.key)).toEqual(['r'])
})

/** A drawn row with its own id. */
const row = (id: string, owner: string, can: RowRef['can']): RowRef => ({ id, owner, group: 's', can })

test('bulkTargets: with no marked row there is no bulk, so the key acts on the selected row (route)', () => {
  expect(bulkTargets(core('dismiss'), [], items)).toBeUndefined()
  expect(bulkTargets(core('prio-1'), [], items)).toBeUndefined()
})

test('bulkTargets: x takes the marked rows with can.dismiss, once each, in the order given', () => {
  const marked = [
    row('a', 'items', ALL),
    row('b', 'repos', {}),
    row('c', 'repos', { dismiss: true }),
    row('a', 'items', ALL),
  ]
  expect(bulkTargets(core('dismiss'), marked, items)).toEqual({ to: 'dismiss', rowIds: ['a', 'c'] })
})

test('dismissTargets: the marked rows with can.dismiss, once each, in the order given', () => {
  const marked = [
    row('a', 'items', ALL),
    row('b', 'repos', {}),
    row('c', 'repos', { dismiss: true }),
    row('a', 'items', ALL),
  ]
  expect(dismissTargets(marked)).toEqual(['a', 'c'])
  expect(dismissTargets([])).toEqual([])
  expect(dismissTargets([row('b', 'repos', {})])).toEqual([])
})

test('bulkTargets: a digit takes the marked rows with can.priority of an item owner', () => {
  const marked = [row('a', 'items', ALL), row('b', 'repos', { priority: true }), row('c', 'items', { dismiss: true })]
  for (const id of ['prio-1', 'prio-2', 'prio-3', 'prio-0'])
    expect(bulkTargets(core(id), marked, items), id).toEqual({ to: 'priority', rowIds: ['a'], level: PRIO_LEVEL[id] })
})

test('bulkTargets: marked rows that allow the key by none give no row ids: marks win, the key is dim', () => {
  const marked = [row('b', 'repos', {}), row('c', 'repos', { priority: true })]
  expect(bulkTargets(core('dismiss'), marked, items)).toEqual({ to: 'dismiss', rowIds: [] })
  expect(bulkTargets(core('prio-1'), marked, items)).toEqual({ to: 'priority', rowIds: [], level: 'high' })
})

test('only x asks before it acts on many rows: it is the one core key with the confirm flag, and no tracker key can have it', () => {
  expect(CORE_KEYS.filter(k => k.confirm === true).map(k => k.id)).toEqual(['dismiss'])
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  expect(reg.all().filter(k => k.owner !== 'core' && k.confirm !== undefined)).toEqual([])
})

test('route and bulkTargets take the same rows for a key and do the same work on them (one table of row keys)', () => {
  const rows = [
    row('a', 'items', ALL),
    row('b', 'items', { dismiss: true }),
    row('c', 'items', { priority: true }),
    row('d', 'repos', ALL),
    row('e', 'repos', {}),
    row('f', 'repos', undefined),
  ]
  const bulkKeys = CORE_KEYS.filter(k => k.id === 'dismiss' || Object.hasOwn(PRIO_LEVEL, k.id))
  expect(bulkKeys.map(k => k.id)).toEqual(['dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  for (const k of bulkKeys) {
    for (const r of rows) {
      const one = route(k, r, items)
      const many = bulkTargets(k, [r], items)
      expect(many?.rowIds.length === 1, `${k.id} ${r.id}`).toBe(one.to !== 'none')
      if (one.to === 'dismiss') expect(many, `${k.id} ${r.id}`).toEqual({ to: 'dismiss', rowIds: [r.id] })
      if (one.to === 'priority') {
        expect(many, `${k.id} ${r.id}`).toEqual({ to: 'priority', rowIds: [r.id], level: one.level })
      }
    }
  }
  // The label and the question count `dismissTargets`; the press acts on `bulkTargets`: both name the same rows.
  expect(bulkTargets(core('dismiss'), rows, items)).toEqual({ to: 'dismiss', rowIds: dismissTargets(rows) })
})

test('bulkTargets: the pane keys, m and a tracker key are single-row: no bulk', () => {
  const marked = [row('a', 'items', ALL)]
  for (const id of ['refresh', 'help', 'view', 'show-all', 'touched', 'mark', 'quick', 'preview', 'diff']) {
    expect(bulkTargets(core(id), marked, items), id).toBeUndefined()
  }
  const open = { id: 'open', key: 'o', label: 'open', scope: 'row', owner: 'items' } as const
  expect(bulkTargets(open, marked, items)).toBeUndefined()
})

test('footerKeys with marked rows: x and the digits are live when a marked row allows them, whatever the selected row is', () => {
  const reg = new KeyRegistry()
  const live = (selected: RowRef | undefined, markedRows: readonly RowRef[]) =>
    Object.fromEntries(footerKeys(reg, selected, items, false, undefined, markedRows).map(k => [k.key, k.enabled]))
  const process = ref('processes', {}) // a row that takes no bulk key
  const marked = [row('a', 'repos', { dismiss: true }), row('b', 'repos', { dismiss: true })]
  expect(live(process, marked)).toEqual({ r: true, h: true, x: true, 1: false, 2: false, 3: false, 0: false })
  // Marks win: an item row selected, two repo rows marked: the digits are dim, though the selected row takes them.
  expect(live(ref('items'), marked)).toMatchObject({ x: true, 1: false, 0: false })
  // A marked row that allows nothing leaves x dim as well, though the selected row could be dismissed.
  expect(live(ref('items'), [row('p', 'processes', {})])).toMatchObject({ x: false, 1: false })
  // No marked row: the selected row decides, as before.
  expect(live(ref('items'), [])).toMatchObject({ x: true, 1: true })
  expect(live(process, [])).toMatchObject({ x: false, 1: false })
})

test('footerKeys with marked rows leaves the keys of a tracker on the selected row, and the help view as it was', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const marked = [row('m1', 'a', { dismiss: true })]
  const keys = footerKeys(reg, ref('a'), items, false, undefined, marked)
  expect(keys.find(k => k.id === 'open')?.enabled).toBe(true)
  const help = footerKeys(reg, ref('a'), items, true, undefined, marked)
  expect(help.filter(k => k.enabled).map(k => k.key)).toEqual(['r', 'h'])
})

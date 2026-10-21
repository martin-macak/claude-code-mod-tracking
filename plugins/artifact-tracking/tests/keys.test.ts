// KeyRegistry and the key routing: which keys exist, which are dropped at init, and where a key press goes.
// Pure. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Keys". Plan: L6 Task 6 (G6, G7, G16).
import { expect, test } from 'claude-code/testing'
import { buttonKeyOf, CORE_KEYS, footerKeys, KeyRegistry, PRIO_LEVEL, route } from '../core/infra/keys'
import type { KeySpec } from '../core/interfaces/tracker'
import type { RowRef } from '../core/interfaces/view'
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

test("core keys are r h x 1 2 3 0 in footer order with today's labels", () => {
  expect(CORE_KEYS.map(k => k.key)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  expect(CORE_KEYS.map(k => k.label)).toEqual(['refresh', 'help', 'dismiss', 'high', 'normal', 'low', 'auto'])
  expect(CORE_KEYS.map(k => k.id)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  expect(CORE_KEYS.every(k => k.owner === 'core')).toBe(true)
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
  reg.add('t', [spec('open', 'o'), spec('open', 'p')])
  expect(reg.get('t.open')?.key).toBe('o')
  expect(reg.problems()).toEqual(['keys: t key "p" (open) repeats the key id "open" of t. The key is off.'])
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
  reg.add('b', [spec('other', 'p')])
  const keys = footerKeys(reg, ref('a', { dismiss: true }), items, false, (_owner, id) =>
    id === 'kill' ? 'disabled' : 'enabled',
  )
  expect(keys.map(buttonKeyOf)).toEqual([...CORE_KEYS.map(k => k.id), 'a.open', 'a.kill'])
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
  expect(keys.map(buttonKeyOf)).toEqual(CORE_KEYS.map(k => k.id))
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
  expect(keys.map(buttonKeyOf)).toEqual([...CORE_KEYS.map(k => k.id), 'a.open'])
})

test('footerKeys: each key carries its footer Button key, the one the registry finds it by', () => {
  const reg = new KeyRegistry()
  reg.add('a', [spec('open', 'o')])
  const keys = footerKeys(reg, ref('a'), items, false)
  expect(keys.map(k => k.buttonKey)).toEqual([...CORE_KEYS.map(k => k.id), 'a.open'])
  for (const k of keys) expect(reg.get(k.buttonKey)?.id).toBe(k.id)
})

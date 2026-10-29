// The press of the band Button `9: open` (issue #69): it selects the first entry of the newest turn that tracked anything
// that the pane lists, opens the pane with the keys, marks the listed entries of the turn that `m` could mark (issue #232; a second
// press on the same turn clears them) and asks for the ring. On the real manager over fakePorts.
import { expect, test } from 'claude-code/testing'
import type { TurnLedger } from '../core/interfaces/turns'
import type { SectionSpec, TreeRow } from '../core/interfaces/view'
import { MAX_ENTRIES } from '../core/lib/turn-entries'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import { type FakeConfig, fakeConfig } from './fixtures/config-fs'
import { buttonOf, press as pressButton, rowBoxes, starsOf, viewWords } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { promptRow, responseRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { ANSWERED_ASK } from './fixtures/questions'

const url = (n: number | string) => `https://docs.example/${n}`

function world(file: Record<string, unknown> = {}) {
  let config!: FakeConfig // the fake of this world: a test that changes the caps between two presses calls `config.set`
  const t = managerWorld({ config: specs => (config = fakeConfig({ specs, file: file as never })) })
  const pane = new PaneSession()
  const turn = async (n: number, text: string, extra?: string) => {
    await t.m.row(t.w.ports, promptRow(text))
    await t.m.turnStart(t.w.ports, { turnId: `t${n}`, text })
    if (extra !== undefined) await t.m.row(t.w.ports, responseRow(extra))
    await t.m.turnComplete(t.w.ports, { input: { turnId: `t${n}`, reason: 'answer' } })
  }
  const press = () => pane.openTurn(t.w.ports, t.m)
  /** The press of the open Button of a strip: it names its own turn. */
  const pressTurn = (ord: number) => pane.openTurn(t.w.ports, t.m, ord)
  const selected = () => t.w.state.get('selected') as unknown as string | null | undefined
  const keyOf = (u: string) => t.items().find(r => r.url === u)!.key
  const marks = () => (t.w.state.get('marks') ?? []) as unknown as string[]
  const draw = () => pane.draw(t.w.ports, t.m, EL, { bodyColumns: 120 })
  return { ...t, config, pane, turn, press, pressTurn, selected, keyOf, marks, draw }
}

test('R11: the press selects the first entry of the newest turn, opens the pane with the keys and asks for the ring', async () => {
  const t = world()
  await t.turn(1, `one ${url('c')}`)
  await t.turn(2, `two ${url('a')} and ${url('b')}`)
  await t.press()
  expect(t.selected()).toBe(t.keyOf(url('a'))) // the first entry of turn 2, not of turn 1
  expect(t.w.ui.opened).toBe(1)
  // The row is selected before the open, so the first drawing of a pane that opens now selects it and takes the ring.
  expect(t.w.ui.openedWith).toEqual([t.keyOf(url('a'))])
  expect(t.w.ui.toasts).toEqual([])
  expect(t.w.ui.focused).toHaveLength(1)
  expect(t.w.ui.focused[0]).toMatch(/^r\d+$/) // the handle of the selected row
  expect(t.marks()).toEqual([t.keyOf(url('a')), t.keyOf(url('b'))]) // #232: the press marks every listed entry of the turn
})

test('R11: the first entry is the first one the turn lists: what it added, then what it saw again', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.turn(2, `two ${url('a')} and ${url('b')}`) // a is seen again, b is new
  await t.press()
  expect(t.selected()).toBe(t.keyOf(url('b')))
})

test('R11: with an empty last turn the press opens the newest turn that tracked anything', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.turn(2, 'an empty turn')
  await t.press()
  expect(t.selected()).toBe(t.keyOf(url('a')))
})

test('R11: an entry the pane does not list is passed over for the next one that it lists', async () => {
  // Five rows fit a section. The sixth is the new item of turn 2: it is the first entry, and the pane cuts it.
  const t = world({ global: { ui: { sectionRows: 5 } } })
  await t.turn(1, [1, 2, 3, 4, 5].map(i => url(`p${i}`)).join(' '))
  await t.turn(2, `${url('p1')} and ${url('q')}`)
  const turn = await t.m.bandTurn()
  expect(turn?.keys).toEqual([t.keyOf(url('q')), t.keyOf(url('p1'))])
  await t.press()
  expect(t.selected()).toBe(t.keyOf(url('p1')))
  expect(t.w.ui.toasts).toEqual([])
})

test('R11: when no entry is listed the pane opens, nothing is selected and a toast names the turn', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.m.dismiss(t.w.ports, [t.keyOf(url('a'))]) // the entry has no row left
  await t.press()
  expect(t.selected() ?? null).toBeNull()
  expect(t.w.ui.opened).toBe(1)
  expect(t.w.ui.toasts).toEqual(['turn 1: its rows are not listed'])
  expect(t.w.ui.focused).toEqual([])
})

test('R11: with no room for the pane a toast says so, and no ring is asked for', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  t.w.ui.placed = false
  await t.press()
  expect(t.w.ui.toasts).toEqual(['Widen the terminal to see the tracking pane'])
  expect(t.w.ui.focused).toEqual([])
  // No pane came, so no selection stays: a later /track must not open on a row the person never chose.
  expect(t.selected() ?? null).toBeNull()
  expect(t.w.ui.openedWith).toEqual([t.keyOf(url('a'))]) // it was set for the first drawing of a pane that might open
})

test('R11: a refused open puts back the selection that stood before, and leaves a selection that changed meanwhile', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  t.w.state.set('selected', 'row-before')
  t.w.ui.placed = false
  await t.press()
  expect(t.selected()).toBe('row-before')
  // A person's own write between the press and the answer of the engine wins.
  const open = t.w.ports.ui.open
  t.w.ports.ui.open = async () => {
    t.w.state.set('selected', 'row-by-person')
    return open()
  }
  await t.press()
  expect(t.selected()).toBe('row-by-person')
})

test('R11: a turn with no listed row clears an older selection before the pane opens, so no stale row stands', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.m.dismiss(t.w.ports, [t.keyOf(url('a'))]) // the entry has no row left
  t.w.state.set('selected', 'row-before')
  await t.press()
  expect(t.selected() ?? null).toBeNull()
  expect(t.w.ui.openedWith).toEqual([null])
  expect(t.w.ui.toasts).toEqual(['turn 1: its rows are not listed'])
})

test('R11: with no turn at all the press only opens the pane', async () => {
  const t = world()
  await t.press()
  expect(t.w.ui.opened).toBe(1)
  expect(t.selected() ?? null).toBeNull()
  expect(t.w.ui.toasts).toEqual([])
  expect((t.w.state.get('turns') as unknown as TurnLedger | undefined)?.turns ?? []).toEqual([])
})

// ---------------------------------------------------------------- a press that began before a closing (issues #130, #139)

test('R11: a pane that closes while the press waits gets no ring, and the closing leaves no selection', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  const open = t.w.ports.ui.open
  t.w.ports.ui.open = async () => {
    await t.pane.closed(t.w.ports) // the pane closed between the press and the answer of the engine
    return open()
  }
  await t.press()
  expect(t.w.ui.focused).toEqual([])
  expect(t.selected() ?? null).toBeNull()
})

test('R11: a pane that closed before the press wrote its selection gets none', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  const band = t.m.bandTurn.bind(t.m)
  t.m.bandTurn = async () => {
    const turn = await band()
    await t.pane.closed(t.w.ports) // the closing comes after the press began, before it writes
    return turn
  }
  await t.press()
  expect(t.w.ui.openedWith).toEqual([null]) // the selection was not written before the open
  expect(t.selected() ?? null).toBeNull()
  expect(t.w.ui.focused).toEqual([])
})

test('R11: a refused open after a closing does not put back the selection that the closing cleared', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.m.dismiss(t.w.ports, [t.keyOf(url('a'))]) // no row is listed, so the press wants no selection (null)
  t.w.state.set('selected', 'row-before')
  t.w.ui.placed = false
  const open = t.w.ports.ui.open
  t.w.ports.ui.open = async () => {
    await t.pane.closed(t.w.ports)
    return open()
  }
  await t.press()
  expect(t.selected() ?? null).toBeNull() // a restore would bring 'row-before' back into a pane that is closed
})

// ---------------------------------------------------------------- the refresh of the press (owner decision of 2026-10-21)

/** The reasons of `ItemsHost.kick`, in the order they came. */
function kicks(t: ReturnType<typeof world>): string[] {
  const seen: string[] = []
  const kick = t.m.items.kick.bind(t.m.items)
  t.m.items.kick = reason => {
    seen.push(reason)
    kick(reason)
  }
  return seen
}

test('R11: the press runs the same refresh as /track: kick("open"), once, after the pane opened', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  const seen = kicks(t)
  const open = t.w.ports.ui.open
  t.w.ports.ui.open = async () => {
    expect(seen).toEqual([]) // the refresh waits for the pane, as /track opens the pane first
    return open()
  }
  await t.press()
  expect(seen).toEqual(['open'])
})

test('R11: with no room for the pane the press refreshes nothing: no pane came to show the rows', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  const seen = kicks(t)
  t.w.ui.placed = false
  await t.press()
  expect(seen).toEqual([])
})

test('R11: a press that finds no turn still runs the refresh of /track', async () => {
  const t = world()
  const seen = kicks(t)
  await t.press()
  expect(seen).toEqual(['open'])
})

// ---------------------------------------------------------------- the open Button of a strip (issue #69, P2)

test('P2: the open Button of a strip opens the turn it belongs to, not the newest: first listed entry selected, pane focused, refresh run', async () => {
  const t = world()
  await t.turn(1, `one ${url('c')}`)
  await t.turn(2, `two ${url('a')} and ${url('b')}`)
  const seen = kicks(t)
  await t.pressTurn(1)
  expect(t.selected()).toBe(t.keyOf(url('c'))) // turn 1's entry, though turn 2 is the newest
  expect(t.w.ui.openedWith).toEqual([t.keyOf(url('c'))])
  expect(t.w.ui.opened).toBe(1)
  expect(t.w.ui.focused).toHaveLength(1)
  expect(t.w.ui.toasts).toEqual([])
  expect(seen).toEqual(['open']) // the refresh of /track, as the band Button runs it
})

test('P2: the open Button of a turn that the ledger no longer keeps opens the pane and says so in a toast', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  t.w.state.set('selected', 'row-before')
  await t.pressTurn(99)
  expect(t.w.ui.opened).toBe(1)
  expect(t.selected()).toBe('row-before') // no entry to select: the person's selection stands
  expect(t.w.ui.toasts).toEqual(['turn 99 is no longer kept'])
  expect(t.w.ui.focused).toEqual([])
})

test('P2: the open Button of a turn whose rows the pane does not list names the turn in its toast', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.turn(2, `two ${url('b')}`)
  await t.m.dismiss(t.w.ports, [t.keyOf(url('a'))]) // turn 1's entry has no row left
  await t.pressTurn(1)
  expect(t.w.ui.toasts).toEqual(['turn 1: its rows are not listed'])
})

test('P2: the open Button of a strip with no room for the pane refreshes nothing and puts the selection back', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.turn(2, `two ${url('b')}`)
  t.w.state.set('selected', 'row-before')
  t.w.ui.placed = false
  const seen = kicks(t)
  await t.pressTurn(1)
  expect(seen).toEqual([])
  expect(t.selected()).toBe('row-before')
  expect(t.w.ui.toasts).toEqual(['Widen the terminal to see the tracking pane'])
})

// ---------------------------------------------------------------- the marks of the press (issue #232)

test('#232 AC1: the press marks every entry of the turn that the pane lists, in the order of the turn, and the view line counts them', async () => {
  const t = world()
  await t.turn(1, `one ${url('c')}`)
  await t.turn(2, `two ${url('a')} and ${url('b')} and ${url('c')}`) // c is seen again: it is an entry of turn 2 too
  const turn = await t.m.bandTurn()
  await t.press()
  expect(t.marks()).toEqual(turn!.keys)
  expect(t.marks()).toHaveLength(3)
  const tree = await t.draw()
  expect(viewWords(tree)).toBe('View: list · 3 marked')
  expect(starsOf(tree)).toBe(3)
  expect(t.selected()).toBe(turn!.keys[0]) // the first entry is still the one that is selected
})

test('#232 AC1: an entry that the pane does not list is not marked', async () => {
  const t = world({ global: { ui: { sectionRows: 5 } } })
  await t.turn(1, [1, 2, 3, 4, 5].map(i => url(`p${i}`)).join(' '))
  await t.turn(2, `${url('p1')} and ${url('q')}`) // q is the sixth item: the pane cuts it
  await t.press()
  expect(t.marks()).toEqual([t.keyOf(url('p1'))])
  expect(viewWords(await t.draw())).toBe('View: list · 1 marked')
})

test('#232 AC1: a turn with no listed row marks nothing', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.m.dismiss(t.w.ports, [t.keyOf(url('a'))])
  await t.press()
  expect(t.marks()).toEqual([])
})

test('#232 AC1: a turn over the ledger cap marks the keys that the ledger keeps, and the count says so', async () => {
  // The ledger keeps MAX_ENTRIES new entries of a turn. With room for all of them and ten more, the pane draws every row and ten stay unmarked.
  const total = MAX_ENTRIES + 10
  const t = world({ global: { ui: { sectionRows: total } } })
  await t.turn(1, Array.from({ length: total }, (_, i) => url(i)).join(' '))
  const turn = await t.m.bandTurn()
  expect(turn?.keys).toHaveLength(MAX_ENTRIES)
  await t.press()
  expect(t.marks()).toEqual(turn!.keys)
  const tree = await t.draw()
  expect(rowBoxes(tree)).toHaveLength(total)
  expect(viewWords(tree)).toBe(`View: list · ${MAX_ENTRIES} marked`)
})

test('#232 AC2: a second press on the same turn clears the marks, a third marks them again', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')}`)
  await t.press()
  expect(t.marks()).toHaveLength(2)
  expect(viewWords(await t.draw())).toBe('View: list · 2 marked')
  await t.press()
  expect(t.marks()).toEqual([])
  expect(viewWords(await t.draw())).toBe('View: list')
  await t.press()
  expect(t.marks()).toHaveLength(2)
})

test('#232 AC2: a press on another turn sets the marks to that turn, so older marks go', async () => {
  const t = world()
  await t.turn(1, `one ${url('c')}`)
  await t.turn(2, `two ${url('a')} and ${url('b')}`)
  await t.pressTurn(2)
  expect(t.marks()).toEqual([t.keyOf(url('a')), t.keyOf(url('b'))])
  await t.pressTurn(1) // not the same turn: the marks are the rows of turn 1 now
  expect(t.marks()).toEqual([t.keyOf(url('c'))])
})

/** `paneData` of the world with each section changed by `change`: a row that the trackers of the world do not make (one that takes no bulk key, a child). */
function reshape(
  t: ReturnType<typeof world>,
  change: (sections: readonly SectionSpec[]) => readonly SectionSpec[],
): void {
  const host: PaneHost = t.m // the same object, typed with a `paneData` that a test may replace
  const real = host.paneData.bind(host)
  host.paneData = async (p, v) => change(await real(p, v))
}

test('#232 AC1: the first press on a turn that holds the rows of another turn marks them, and the second press on that turn clears them', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.turn(2, `two ${url('a')}`) // turn 2 only saw a again: its rows are the rows of turn 1
  await t.pressTurn(1)
  expect(t.marks()).toEqual([t.keyOf(url('a'))])
  await t.pressTurn(2) // another turn than the last press named: it sets the marks, though they are its rows already
  expect(t.marks()).toEqual([t.keyOf(url('a'))])
  await t.pressTurn(2)
  expect(t.marks()).toEqual([])
})

test('#232 AC1: a mark of the person that is exactly the rows of the turn does not make the first press a clear', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  t.w.state.set('marks', [t.keyOf(url('a'))]) // the person marked it with m
  await t.press()
  expect(t.marks()).toEqual([t.keyOf(url('a'))])
  await t.press() // the second press on the same turn
  expect(t.marks()).toEqual([])
})

test('#232 AC2: a second press clears the marks although a row of the turn hid since, and the view line counts no mark then', async () => {
  const t = world({ global: { ui: { sectionRows: 10 } } })
  await t.turn(1, [1, 2, 3, 4, 5, 6].map(i => url(`p${i}`)).join(' '))
  await t.press()
  expect(t.marks()).toHaveLength(6)
  t.config.set({ global: { ui: { sectionRows: 5 } } }) // the section holds five rows now: the sixth hides and keeps its mark
  expect(viewWords(await t.draw())).toBe('View: list · 5 marked')
  await t.press()
  expect(t.marks()).toEqual([])
  expect(viewWords(await t.draw())).toBe('View: list')
})

test('#232 AC2: a second press clears the marks although a row of the turn was dismissed since', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')}`)
  await t.press()
  await t.m.dismiss(t.w.ports, [t.keyOf(url('b'))])
  expect(viewWords(await t.draw())).toBe('View: list · 1 marked')
  await t.press()
  expect(t.marks()).toEqual([])
  expect(viewWords(await t.draw())).toBe('View: list')
})

test('#232 AC2: a mark that m added since is counted, so the second press sets the marks to the turn again', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.turn(2, `two ${url('b')}`)
  await t.pressTurn(2)
  t.w.state.set('marks', [t.keyOf(url('b')), t.keyOf(url('a'))]) // m on a row of turn 1
  await t.pressTurn(2)
  expect(t.marks()).toEqual([t.keyOf(url('b'))])
})

test('#232 AC1: a press on a turn that the pane lists no row of drops the older marks, so x and the digits act on no row of another turn', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')}`)
  await t.turn(2, `two ${url('c')}`)
  await t.m.dismiss(t.w.ports, [t.keyOf(url('c'))]) // the only entry of turn 2 has no row left
  await t.pressTurn(1)
  expect(t.marks()).toHaveLength(2)
  await t.pressTurn(2)
  expect(t.w.ui.toasts).toEqual(['turn 2: its rows are not listed'])
  expect(t.marks()).toEqual([])
  expect(viewWords(await t.draw())).toBe('View: list')
})

test('#232 AC1: a press on a turn that the ledger no longer keeps, or on no turn, leaves the marks as they were', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  t.w.state.set('marks', [t.keyOf(url('a'))]) // a mark of the person
  await t.pressTurn(99) // no turn: the person pressed no turn
  expect(t.marks()).toEqual([t.keyOf(url('a'))])
  const none = world()
  none.w.state.set('marks', ['x'])
  await none.press() // no turn at all
  expect(none.marks()).toEqual(['x'])
})

test('#232 AC1: a question call of the turn is listed and selected, and the press does not mark it', async () => {
  const t = world()
  await t.m.row(t.w.ports, promptRow(`one ${url('a')}`))
  await t.m.turnStart(t.w.ports, { turnId: 't1', text: `one ${url('a')}` })
  await t.m.toolCall(t.w.ports, ANSWERED_ASK)
  await t.m.turnComplete(t.w.ports, { input: { turnId: 't1', reason: 'answer' } })
  const turn = await t.m.bandTurn()
  expect(turn?.keys).toHaveLength(2) // the url and the call: the call takes no bulk key
  await t.press()
  expect(t.marks()).toEqual([t.keyOf(url('a'))])
  expect(viewWords(await t.draw())).toBe('View: list · 1 marked')
})

test('#232 AC1: the press marks only the listed entries that m could mark: a first entry that takes no bulk key is selected, not marked', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')}`)
  const a = t.keyOf(url('a'))
  reshape(t, sections =>
    sections.map(s => ({
      ...s,
      rows: s.rows.map(r => (r.id === a ? { ...r, can: { dismiss: false, priority: false } } : r)),
    })),
  )
  await t.press()
  expect(t.selected()).toBe(a) // listed, so selected
  expect(t.marks()).toEqual([t.keyOf(url('b'))]) // but m could not mark it
  expect(viewWords(await t.draw())).toBe('View: list · 1 marked')
})

test('#232 AC1: an entry below a closed row is not marked, and it is once the row is open', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')}`)
  const [a, b] = [t.keyOf(url('a')), t.keyOf(url('b'))]
  const nest = (rows: readonly TreeRow[], child: TreeRow | undefined): readonly TreeRow[] =>
    rows.filter(r => r.id !== b).map(r => (r.id === a && child ? { ...r, children: [child] } : r))
  reshape(t, sections => {
    const child = sections.flatMap(s => s.rows).find(r => r.id === b)
    return sections.map(s => ({ ...s, rows: nest(s.rows, child) }))
  })
  await t.press()
  expect(t.marks()).toEqual([a]) // b sits below a, and a is closed
  await t.press() // the second press clears
  t.w.state.set('expanded', [a])
  await t.press()
  expect(t.marks()).toEqual([a, b])
})

test('#232 AC1: in another view the press marks the rows that view lists, in the order of the turn', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')}`)
  t.w.state.set('view', 'status')
  await t.press()
  expect(t.marks()).toEqual((await t.m.bandTurn())!.keys)
  expect(viewWords(await t.draw())).toBe('View: status · 2 marked')
})

test('#232 AC1: a filter that hides the rows of the turn leaves them unmarked', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`) // a url in a prompt is a mention: the filter t hides it
  t.w.state.set('filters', { touchedOnly: true })
  await t.press()
  expect(t.marks()).toEqual([])
  expect(t.w.ui.toasts).toEqual(['turn 1: its rows are not listed'])
})

test('#232: with no room for the pane nothing is marked, so a later /track opens with no mark nobody made', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  t.w.ui.placed = false
  await t.press()
  expect(t.marks()).toEqual([])
})

test('#232: a press that began before a closing writes no marks', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  const open = t.w.ports.ui.open
  t.w.ports.ui.open = async () => {
    await t.pane.closed(t.w.ports)
    return open()
  }
  await t.press()
  expect(t.marks()).toEqual([])
})

test('#232: a press that began before a closing does not keep its turn, so the first press of the next pane on that turn marks', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  const open = t.w.ports.ui.open
  t.w.ports.ui.open = async () => {
    await t.pane.closed(t.w.ports) // the pane closed between the press and the answer of the engine
    return open()
  }
  await t.press()
  t.w.ports.ui.open = open
  expect(t.marks()).toEqual([])
  t.w.state.set('marks', [t.keyOf(url('a'))]) // the person marks the one row of the turn with m in the next pane
  await t.press()
  expect(t.marks()).toEqual([t.keyOf(url('a'))]) // a first press sets the marks to the turn: a stale turn would take it for a second press and clear
})

test('#232 AC2: a closing makes the next press on the same turn a first press', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.press()
  expect(t.marks()).toEqual([t.keyOf(url('a'))])
  await t.pane.closed(t.w.ports)
  expect(t.marks()).toEqual([]) // the closing ends the marks
  t.w.state.set('marks', [t.keyOf(url('a'))]) // the person marks the one row of the turn with m in the next pane
  await t.press()
  expect(t.marks()).toEqual([t.keyOf(url('a'))]) // not a second press: the turn of the last press is forgotten
})

test('#232 AC3: x after the press asks first; the second x from a drawing that shows the question dismisses the turn', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')} and ${url('c')}`)
  await t.press()
  const marked = [...t.marks()]
  pressButton(buttonOf(await t.draw(), 'dismiss'))
  await t.pane.idle()
  expect(t.marks()).toEqual(marked) // asked: nothing dismissed, nothing cleared
  const asked = await t.draw()
  expect(viewWords(asked)).toBe('Dismiss 3 marked rows? x again: yes')
  expect(rowBoxes(asked)).toHaveLength(3)
  pressButton(buttonOf(asked, 'dismiss'))
  await t.pane.idle()
  expect(t.marks()).toEqual([])
  expect(rowBoxes(await t.draw())).toHaveLength(0) // the three rows are gone
})

test('#232 AC3: a turn with one entry marks it, and x on it dismisses at once, as x on the selected row did', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')}`)
  await t.press()
  expect(t.marks()).toEqual([t.keyOf(url('a'))])
  pressButton(buttonOf(await t.draw(), 'dismiss'))
  await t.pane.idle()
  expect(rowBoxes(await t.draw())).toHaveLength(0)
})

test('#232 AC4: the order of a press: the selection, the open, the refresh, the marks, then the selection and the ring request of the refocus', async () => {
  const t = world()
  await t.turn(1, `one ${url('a')} and ${url('b')}`)
  const seen: string[] = []
  const { ports } = t.w
  const watch = <T extends object>(obj: T, name: keyof T & string, label: string): void => {
    const real = (obj[name] as unknown as (...a: unknown[]) => unknown).bind(obj)
    ;(obj as Record<string, unknown>)[name] = (...a: unknown[]) => {
      seen.push(label)
      return real(...a)
    }
  }
  watch(ports.state.selected, 'update', 'selected')
  watch(ports.state.marks, 'update', 'marks')
  watch(ports.ui, 'open', 'open')
  watch(ports.ui, 'focus', 'ring')
  t.m.items.kick = () => void seen.push('refresh')
  await t.press()
  expect(seen).toEqual(['selected', 'open', 'refresh', 'marks', 'selected', 'ring'])
  const firstPress = seen.length
  await t.press() // the second press: the same order, and the marks write is the clear
  expect(seen.slice(firstPress)).toEqual(['open', 'refresh', 'marks', 'selected', 'ring']) // the first selection write is gone: same row
  expect(t.marks()).toEqual([])
})

// The press of the band Button `9: open` (issue #69): it selects the first entry of the newest turn that tracked anything
// that the pane lists, opens the pane with the keys, and asks for the ring. On the real manager over fakePorts.
import { expect, test } from 'claude-code/testing'
import type { TurnLedger } from '../core/interfaces/turns'
import { PaneSession } from '../hooks/pane-session'
import { fakeConfig } from './fixtures/config-fs'
import { promptRow, responseRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

const url = (n: number | string) => `https://docs.example/${n}`

function world(file: Record<string, unknown> = {}) {
  const t = managerWorld({ config: specs => fakeConfig({ specs, file: file as never }) })
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
  return { ...t, pane, turn, press, pressTurn, selected, keyOf }
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
  // The press leaves the marks alone: #138 gives the seam (`writeMarks`), and marking a turn is #232 (owner decision Q5).
  expect(t.w.state.get('marks') ?? []).toEqual([])
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

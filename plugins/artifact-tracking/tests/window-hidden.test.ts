// The window over the rows (issue #109) and the rows that a TTL hides (issue #49). The trackers filter the hidden rows out
// of their sections, so the window plans over the shown rows only: a hidden row has no unit, no focus stop and no part in
// the "N more above/below" counts. The pane is drawn through PaneSession, as register.tsx does. The clock is the world's.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import type { ProcessRecord } from '../trackers/processes/types'
import { handlesOf, leaves, type Node, nodes, rowBoxes, texts } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { NOW, paneWorld } from './fixtures/pane-world'

const MIN = 60_000
type World = Awaited<ReturnType<typeof paneWorld>>

/** A body of 11 rows, 96 cells wide: the inline pane at 100x40. */
const BODY = { bodyColumns: 96, bodyRows: 11 }

const proc = (id: string, state: ProcessRecord['state'], f: Partial<ProcessRecord> = {}): ProcessRecord => ({
  id,
  kind: 'background-task',
  name: id,
  state,
  firstSeen: 3,
  lastSeen: 3,
  ...f,
})

/** Eight running process rows, and eight that ended 40 min ago: past the 30 min TTL, so they hide. */
const processes = (): ProcessRecord[] => [
  ...Array.from({ length: 8 }, (_, i) => proc(`bg:live${i}`, 'running')),
  ...Array.from({ length: 8 }, (_, i) => proc(`bg:done${i}`, 'completed', { endedAt: NOW - 40 * MIN })),
]

async function world(hideEnded: boolean): Promise<World> {
  const t = await paneWorld({ config: { processes: { hideEnded } } })
  t.m.facts.publish('processes.ui', { breaker: 'closed' }) // the world's docker issue would end the note
  t.w.state.set('processes', processes() as unknown as Json)
  return t
}

/** The cells of the rows drawn in full, one string per row: the gutter (`>` marks the selected row), then the cells. */
const rowsOf = (tree: unknown): string[] => rowBoxes(tree).map(b => leaves(b).join('|'))

/** The rows the pane draws in full, the stops of every row, and the numbers its two hints give. */
async function drawn(t: World) {
  const tree = await new PaneSession().draw(t.w.ports, t.m as PaneHost, EL, BODY)
  const hint = (word: 'above' | 'below'): number => {
    const found = texts(tree)
      .map(([, s]) => s.match(new RegExp(`^[▲▼] (\\d+) more ${word}$`)))
      .find(m => m !== null)
    return found === undefined || found === null ? 0 : Number(found[1])
  }
  return { full: rowBoxes(tree).length, stops: handlesOf(tree).length, above: hint('above'), below: hint('below') }
}

test('rows that a TTL hides have no focus stop and do not count in the "N more" hints', async () => {
  const hiding = await drawn(await world(true))
  const showing = await drawn(await world(false))
  // Every row shown has a stop, in the window or out of it, and the hints count exactly the rows out of the window.
  for (const d of [hiding, showing]) expect(d.full + d.above + d.below).toBe(d.stops)
  // The window is windowed in both, and the eight rows that the TTL hides are the whole difference.
  expect(hiding.below).toBeGreaterThan(0)
  expect(showing.stops - hiding.stops).toBe(8)
  expect(showing.below - hiding.below).toBe(8)
  expect(showing.full).toBe(hiding.full)
})

test('the selected row hides in a windowed pane: the selection falls to a row in view and the window follows it', async () => {
  // bg:done7 is the last row of the list, so with it selected the window sits at the end. Its TTL passes with no input, and
  // so does the TTL of every ended row. The pane treats the row before the last ended one as selected (issue #49): the `>`,
  // the ring and the window go to bg:live7, which shows in full. The atom keeps the id of the vanished row, and the engine's
  // own take of the ring (origin plugin) lands on the row the selection fell to and replaces nothing.
  const t = await world(true)
  t.w.clock.now = NOW - 20 * MIN // the ended rows are 20 min old: they still show
  t.w.state.set('selected', 'bg:done7')
  const session = new PaneSession()
  const draw = () => session.draw(t.w.ports, t.m as PaneHost, EL, BODY)
  const before = await draw()
  expect(rowsOf(before).filter(r => r.startsWith('>'))).toEqual(['>|bg|bg:done7|background task|completed'])

  t.w.clock.now = NOW + 10 * MIN // 50 min after they ended: every ended row is past its TTL
  const after = await draw()
  expect(rowsOf(after).some(r => r.includes('bg:done'))).toBe(false) // the hidden rows are no unit of the window
  const stops = handlesOf(after).length
  expect(handlesOf(before).length - stops).toBe(8) // the eight hidden rows lost their stops
  // The window follows the row the selection fell to: the last live row is in view and marked, nothing is below it, and the
  // hint above counts the rows out of view and no hidden row.
  expect(rowsOf(after).filter(r => r.startsWith('>'))).toEqual(['>|bg|bg:live7|background task|running'])
  const hint = (word: 'above' | 'below'): number =>
    Number(
      texts(after)
        .find(([, s]) => new RegExp(`^[▲▼] \\d+ more ${word}$`).test(s))?.[1]
        .match(/\d+/)?.[0] ?? 0,
    )
  expect(hint('below')).toBe(0)
  expect(rowsOf(after).length + hint('above')).toBe(stops)
  expect(t.w.state.get('selected')).toBe('bg:done7') // nothing writes the atom

  // The table puts `autoFocus` on the row that the `>` marks, not on the first row in view.
  const ring = nodes(after, 'Button').filter(b => b.props.autoFocus === true)
  expect(ring).toHaveLength(1)
  const marked = rowBoxes(after).find(b => leaves(b)[0] === '>') as Node
  expect(nodes(marked, 'Button').map(b => b.props.key)).toContain(ring[0]?.props.key)
  expect(rowBoxes(after)[0]).not.toBe(marked) // the first row in view is another row: the ring did not default to it

  // The engine takes the ring on that row. The selection is not replaced, and the next drawing is the same drawing.
  await session.focused(t.w.ports, String(ring[0]?.props.key), 'plugin')
  expect(t.w.state.get('selected')).toBe('bg:done7')
  expect(rowsOf(await draw())).toEqual(rowsOf(after))
})

import { expect, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const PANE = {
  plugin: 'kit-focus',
  component: 'Pane',
  requestId: 'p',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'T', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} },
} as const

// Collect the plain text drawn on each row Box.
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const rowsOf = (tree: unknown): { bg: unknown; text: string }[] => {
  const out: { bg: unknown; text: string }[] = []
  const walk = (n: unknown) => {
    if (typeof n !== 'object' || n === null) return
    const node = n as Node
    if (node.type === 'Box' && typeof node.props?.key === 'string' && String(node.props.key).startsWith('box-')) {
      const text = JSON.stringify(node.children)
      out.push({ bg: node.props?.backgroundColor, text })
    }
    for (const c of node.children ?? []) walk(c)
  }
  walk(tree)
  return out
}

test('G04: ui.focus hook writes $.state; the drawing shows the selected row without redraw()', async ($, on) => {
  // Nothing beneath the plugins answers ui.focus in the kit.
  on('ui.focus', () => ({}))
  const ui = await $.ui.mount(PANE)
  const before = rowsOf(await ui.drawn())
  console.log('BEFORE', JSON.stringify(before))
  expect(before.every(r => r.bg === undefined)).toBe(true)

  const result = await $.ui.focus({
    component: 'Pane',
    requestId: 'p',
    plugin: 'kit-focus',
    element: 'row-b',
    origin: { kind: 'person' },
  } as never)
  console.log('FOCUS RESULT', JSON.stringify(result))
  expect(result).toEqual({})

  // No ui.redraw() here: the claim is that the state set redraws the subscribed instance.
  const after = rowsOf(await ui.drawn())
  console.log('AFTER (no redraw)', JSON.stringify(after))
  expect(after[1]?.bg).toBe('blue')
  expect(after[1]?.text).toContain('> ')
  expect(after[0]?.bg).toBeUndefined()

  // A second move.
  await $.ui.focus({ component: 'Pane', requestId: 'p', plugin: 'kit-focus', element: 'row-c', origin: { kind: 'person' } } as never)
  const after2 = rowsOf(await ui.drawn())
  console.log('AFTER 2', JSON.stringify(after2))
  expect(after2[2]?.bg).toBe('blue')
  expect(after2[1]?.bg).toBeUndefined()

  // The engine's own stop (no element) clears the selection.
  await $.ui.focus({ component: 'Pane', requestId: 'p', origin: { kind: 'person' } } as never)
  const after3 = rowsOf(await ui.drawn())
  console.log('AFTER 3 (engine stop)', JSON.stringify(after3))
  expect(after3.every(r => r.bg === undefined)).toBe(true)

  // A plugin-origin move works the same.
  await $.ui.focus({ component: 'Pane', requestId: 'p', plugin: 'kit-focus', element: 'row-a', origin: { kind: 'plugin', name: 'kit-focus' } } as never)
  expect(rowsOf(await ui.drawn())[0]?.bg).toBe('blue')
  await ui.unmount()
})

test('G04 control: a render hook that writes $.state is refused', async ($, on) => {
  on('ui.focus', () => ({}))
  const ui = await $.ui.mount({ ...PANE, requestId: 'bad' })
  const shown = JSON.stringify(await ui.drawn())
  console.log('RENDER-WRITE DRAWN', shown)
  expect(shown).toContain('write-refused')
  await ui.unmount()
})

test('G04: mount without the bottom ui.focus stub shows what the kit does', async ($) => {
  const ui = await $.ui.mount(PANE)
  let outcome = 'resolved'
  try {
    const r = await $.ui.focus({ component: 'Pane', requestId: 'p', plugin: 'kit-focus', element: 'row-b', origin: { kind: 'person' } } as never)
    outcome = 'resolved ' + JSON.stringify(r)
  } catch (err) {
    outcome = 'rejected: ' + String((err as Error).message)
  }
  console.log('NO-BOTTOM-STUB', outcome)
  console.log('NO-BOTTOM-STUB rows', JSON.stringify(rowsOf(await ui.drawn())))
  await ui.unmount()
})

test('G04 variant: write after next(e); a core deny leaves the selection unwritten', async ($, on) => {
  let deny = false
  on('ui.focus', () => (deny ? { deny: 'ring stayed' } : {}))
  const ui = await $.ui.mount({ ...PANE, requestId: 'q' })
  await $.ui.focus({ component: 'Pane', requestId: 'q', plugin: 'kit-focus', element: 'row-a', origin: { kind: 'person' } } as never)
  expect((await rowsOf(await ui.drawn()))[0]?.bg).toBe('blue')
  deny = true
  const r = await $.ui.focus({ component: 'Pane', requestId: 'q', plugin: 'kit-focus', element: 'row-c', origin: { kind: 'person' } } as never)
  console.log('VARIANT deny result', JSON.stringify(r))
  const rows = rowsOf(await ui.drawn())
  console.log('VARIANT rows bg', JSON.stringify(rows.map(x => x.bg)))
  expect(rows[2]?.bg).toBeUndefined()
  expect(rows[0]?.bg).toBe('blue')
  await ui.unmount()
})

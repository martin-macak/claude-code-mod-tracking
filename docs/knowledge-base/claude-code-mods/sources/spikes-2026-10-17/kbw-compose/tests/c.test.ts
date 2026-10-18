import { expect, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const PANE = {
  plugin: 'kbw-compose',
  component: 'Pane',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'T', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} },
  requestId: 'p',
} as const

test('two ui.render hooks with one matcher compose one tree', async $ => {
  const ui = await $.ui.mount(PANE as never)
  const tree = await ui.drawn()
  const json = JSON.stringify(tree)
  console.log('TREE ' + json)
  const a = json.indexOf('A-head')
  const b = json.indexOf('B-body')
  const c = json.indexOf('A-foot')
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  expect(c).toBeGreaterThan(b)
  await ui.unmount()
})

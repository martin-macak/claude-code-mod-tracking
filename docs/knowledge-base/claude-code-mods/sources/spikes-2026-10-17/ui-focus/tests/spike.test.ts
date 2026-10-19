import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'arch-spike-ui',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'spike',
  viewport: { columns: 120, rows: 36 },
  props: {
    title: 'Spike',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('grid: 40 row Buttons plus hotkey Buttons, a press runs the handler', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  const ui = await $.ui.mount(PANE as never)
  const buttons = await (ui as unknown as { findAll(q: unknown): Promise<{ key: string }[]> }).findAll({ type: 'Button' })
  const keys = buttons.map(b => b.key)
  expect(keys.filter(k => k.startsWith('row-'))).toHaveLength(40)
  expect(keys).toContain('hot-h')
  expect(keys).toContain('hidden-z')
  expect(keys).toContain('hot-f')
  await (ui as unknown as { press(q: unknown): Promise<void> }).press({ key: 'row-35' })
  const hdr = await (ui as unknown as { find(q: unknown): Promise<{ text: string } | undefined> }).find({ text: 'last=row-35' })
  expect(hdr).toBeDefined()
  await (ui as unknown as { unmount(): Promise<void> }).unmount()
})

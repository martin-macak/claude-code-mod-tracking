import { mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const pane = (requestId: string) =>
  ({
    plugin: 'r05-render',
    component: 'Pane',
    surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { title: 'T', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} },
    requestId,
  }) as never

const d = (s: string) => Number(/draws=(\d+)/.exec(s)?.[1])

for (const id of ['p0', 'p3', 'p20']) {
  test('invalidate in render, cap ' + id, { timeoutMs: 20000 }, async ($, on) => {
    const clock = mock.clock(on)
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['ENGINE'] }) as never)
    const ui = await $.ui.mount(pane(id))
    const seq: number[] = [d(JSON.stringify(await ui.drawn()))]
    await clock.settle()
    seq.push(d(JSON.stringify(await ui.drawn())))
    for (let i = 0; i < 12; i++) {
      await clock.advance(100)
      seq.push(d(JSON.stringify(await ui.drawn())))
    }
    await clock.advance(5000)
    seq.push(d(JSON.stringify(await ui.drawn())))
    console.log(`== ${id}: draws at mount, settle, then +100ms x12, then +5000ms: ${seq.join(',')}`)
    await ui.unmount()
  })
}

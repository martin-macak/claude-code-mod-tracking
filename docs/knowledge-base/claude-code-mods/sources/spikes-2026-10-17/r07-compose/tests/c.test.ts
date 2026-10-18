import { test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const pane = (title: string, requestId = 'x') =>
  ({
    plugin: 'r07-compose',
    component: 'Pane',
    surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { title, isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} },
    requestId,
  }) as never

function texts(t: unknown, out: string[] = []): string[] {
  if (typeof t === 'string') out.push(t)
  else if (t && typeof t === 'object') for (const c of (t as { children?: unknown[] }).children ?? []) texts(c, out)
  return out
}

for (const [name, title, rid] of [['both wrap', 'T', 'x'], ['A rewrites props', 'REWRITE', 'x'], ['A answers without next', 'NOCALL', 'x'], ['other requestId (no hook)', 'T', 'y']] as const) {
  test(name, async ($, on) => {
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['ENGINE-TREE'] }) as never)
    const ui = await $.ui.mount(pane(title, rid))
    const tree = await ui.drawn()
    console.log(`== ${name}`)
    for (const t of texts(tree)) console.log('   | ' + t)
    console.log('   part=' + JSON.stringify((tree as { part?: unknown }).part))
    await ui.unmount()
  })
}

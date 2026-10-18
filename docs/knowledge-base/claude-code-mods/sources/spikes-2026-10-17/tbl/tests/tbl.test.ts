import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }
declare const performance: { now: () => number }

const PANE = {
  plugin: 'arch-spike-tbl',
  component: 'Pane',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'T', isFocused: true, bodyColumns: 95, placement: 'dock', scroll: { offset: 0, bodyRows: 36 }, view: {} },
} as const

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

type Stats = { nodes: number; buttons: number; strings: number; chars: number; lastRowButton: number; rowButtons: number; moreText: string }
function stats(tree: unknown): Stats {
  const s: Stats = { nodes: 0, buttons: 0, strings: 0, chars: 0, lastRowButton: -1, rowButtons: 0, moreText: '' }
  const walk = (n: unknown) => {
    if (typeof n === 'string') {
      s.strings++
      s.chars += n.length
      if (n.includes('not drawn') && s.moreText === '') s.moreText = n
      return
    }
    if (typeof n !== 'object' || n === null) return
    const node = n as Node
    if (typeof node.type === 'string') {
      s.nodes++
      if (node.type === 'Button') {
        s.buttons++
        const m = /^r(\d+)$/.exec(String(node.props?.key ?? ''))
        if (m) {
          s.rowButtons++
          s.lastRowButton = Math.max(s.lastRowButton, Number(m[1]))
        }
      }
    }
    for (const c of node.children ?? []) walk(c)
  }
  walk(tree)
  return s
}

async function probe($: Engine, id: string): Promise<void> {
  const t0 = performance.now()
  try {
    const ui = await $.ui.mount({ ...PANE, requestId: id } as never)
    const t1 = performance.now()
    const s = stats(await ui.drawn())
    console.log(
      `PROBE ${id.padEnd(22)} DRAWN nodes=${s.nodes} strings=${s.strings} nodes+strings=${s.nodes + s.strings} chars=${s.chars} buttons=${s.buttons} rowButtons=${s.rowButtons} lastRowButton=r${s.lastRowButton} mount=${Math.round(t1 - t0)}ms${s.moreText ? ' CUT:' + s.moreText.slice(0, 80) : ''}`,
    )
    await ui.unmount()
  } catch (err) {
    console.log(`PROBE ${id.padEnd(22)} REFUSED ${String((err as Error).message).slice(0, 300)}`)
  }
}

const T = { timeoutMs: 120000 }

test('R-Q2 kit: rows with natural 40-80 char titles', T, async $ => {
  for (const r of [100, 300, 600, 1000, 1200, 1300, 1400, 1500]) await probe($, `tbl-r${r}-t0`)
})

test('R-Q2 kit: 600 rows, padded titles (text budget)', T, async $ => {
  for (const t of [80, 120, 150, 200]) await probe($, `tbl-r600-t${t}`)
})

test('R-Q2 kit: legacy long Box keys', T, async $ => {
  for (const r of [300, 400, 500, 600]) await probe($, `tbl-r${r}-t0-long`)
})

test('Q1 kit: selection follows ui.focus (raw), footer key and engine stop', T, async ($, on) => {
  on('ui.focus', () => ({}))
  const ui = await $.ui.mount({ ...PANE, requestId: 'tbl' } as never)
  const bgRows = async () => {
    const out: string[] = []
    const walk = (n: unknown) => {
      if (typeof n !== 'object' || n === null) return
      const node = n as Node
      if (node.type === 'Box' && node.props?.backgroundColor === 'blue') {
        const btn = JSON.stringify(node.children).match(/"key":"(r\d+)"/)
        out.push(btn ? btn[1]! : '?')
      }
      for (const c of node.children ?? []) walk(c)
    }
    walk(await ui.drawn())
    return out
  }
  const f = (element?: string) =>
    $.ui.focus({ component: 'Pane', requestId: 'tbl', plugin: 'arch-spike-tbl', ...(element ? { element } : {}), origin: { kind: 'person' } } as never)
  console.log('KIT-Q1 start      highlighted:', JSON.stringify(await bgRows()))
  await f('r5')
  console.log('KIT-Q1 focus r5   highlighted:', JSON.stringify(await bgRows()))
  await f('r6')
  console.log('KIT-Q1 focus r6   highlighted:', JSON.stringify(await bgRows()))
  await f('fx')
  console.log('KIT-Q1 focus fx   highlighted:', JSON.stringify(await bgRows()))
  await f()
  console.log('KIT-Q1 engine stop highlighted:', JSON.stringify(await bgRows()))
  expect(true).toBe(true)
  await ui.unmount()
})

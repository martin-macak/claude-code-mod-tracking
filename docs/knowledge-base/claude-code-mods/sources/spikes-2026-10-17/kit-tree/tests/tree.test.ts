import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }
declare const performance: { now: () => number }

const PANE = {
  plugin: 'kit-tree',
  component: 'Pane',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'T', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} },
} as const

type Stats = { nodes: number; buttons: number; strings: number; chars: number; depth: number; json: number }
function stats(tree: unknown): Stats {
  const s: Stats = { nodes: 0, buttons: 0, strings: 0, chars: 0, depth: 0, json: JSON.stringify(tree).length }
  const walk = (n: unknown, d: number) => {
    if (typeof n === 'string') {
      s.strings++
      s.chars += n.length
      return
    }
    if (typeof n !== 'object' || n === null) return
    const node = n as { type?: string; children?: unknown[] }
    if (typeof node.type === 'string') {
      s.nodes++
      if (node.type === 'Button') s.buttons++
      s.depth = Math.max(s.depth, d)
    }
    for (const c of node.children ?? []) walk(c, d + 1)
  }
  walk(tree, 1)
  return s
}

/** Mounts a Pane of the given size. Logs one line: stats and the outcome (or the refusal text, cut to 400 chars). */
async function probe($: Engine, requestId: string): Promise<'drawn' | 'refused'> {
  const t0 = performance.now()
  try {
    const ui = await $.ui.mount({ ...PANE, requestId } as never)
    const t1 = performance.now()
    const tree = await ui.drawn()
    const s = stats(tree)
    console.log(`PROBE ${requestId.padEnd(22)} DRAWN   nodes=${s.nodes} buttons=${s.buttons} strings=${s.strings} textChars=${s.chars} depth=${s.depth} json=${s.json} mount=${Math.round(t1 - t0)}ms`)
    await ui.unmount()
    return 'drawn'
  } catch (err) {
    const msg = String((err as Error).message)
    console.log(`PROBE ${requestId.padEnd(22)} REFUSED ${msg.slice(0, 420)}`)
    return 'refused'
  }
}

const T = { timeoutMs: 60000 }

test('G17-1: the target tree: 500 rows x 6 cells + header + detail rows', T, async $ => {
  expect(await probe($, 'r500-d1-n0-t0')).toBe('drawn')
})

test('G17-2: row counts up to and past 20,000 nodes', T, async $ => {
  for (const rows of [500, 1000, 1200, 1400, 1500, 1600, 2000, 3000]) await probe($, `r${rows}-d1-n0-t0`)
})

test('G17-3: no detail rows, row count past 20,000 nodes', T, async $ => {
  for (const rows of [1500, 1700, 2000]) await probe($, `r${rows}-d0-n0-t0`)
})

test('G17-4: depth (wrapping Boxes) around a small table', T, async $ => {
  for (const n of [5, 20, 26, 27, 28, 30, 31, 32, 33, 40, 100]) await probe($, `r3-d0-n${n}-t0`)
})

test('G17-5: one long text (characters)', T, async $ => {
  for (const t of [50000, 100000, 100001, 300000, 1000000]) await probe($, `r3-d0-n0-t${t}`)
})

/** The largest row count that draws, by bisection. Prints the counted size at the boundary. */
async function maxRows($: Engine, tail: string): Promise<number> {
  let lo = 1
  let hi = 4000
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    try {
      const ui = await $.ui.mount({ ...PANE, requestId: `r${mid}-${tail}` } as never)
      await ui.unmount()
      lo = mid
    } catch {
      hi = mid - 1
    }
  }
  return lo
}

test('G17-6: boundary by bisection, flat 6-cell rows and the real /track row shape', T, async $ => {
  for (const [label, tail] of [
    ['flat   detail', 'd1-n0-t0'],
    ['flat   nodetail', 'd0-n0-t0'],
    ['real   detail', 'd1-n0-t0-real'],
    ['real   nodetail', 'd0-n0-t0-real'],
  ] as const) {
    const r = await maxRows($, tail)
    // Draw once at the boundary to print the counted size.
    const ui = await $.ui.mount({ ...PANE, requestId: `r${r}-${tail}` } as never)
    const s = stats(await ui.drawn())
    await ui.unmount()
    let refused = ''
    try {
      const u2 = await $.ui.mount({ ...PANE, requestId: `r${r + 1}-${tail}` } as never)
      await u2.unmount()
    } catch (err) {
      refused = String((err as Error).message).replace(/.*refused: /, '')
    }
    console.log(`MAXROWS ${label.padEnd(16)} max=${r}  at max: nodes=${s.nodes} strings=${s.strings} nodes+strings=${s.nodes + s.strings} buttons=${s.buttons} ; rows+1 -> ${refused}`)
  }
})

test('G17-7: the real shape at 500 rows, with and without detail rows', T, async $ => {
  await probe($, 'r500-d1-n0-t0-real')
  await probe($, 'r500-d0-n0-t0-real')
  await probe($, 'r600-d1-n0-t0-real')
  await probe($, 'r700-d1-n0-t0-real')
})

test('G17-8: what the engine puts at a 300000-char cut', T, async $ => {
  const ui = await $.ui.mount({ ...PANE, requestId: 'r3-d0-n0-t300000' } as never)
  const tree = JSON.stringify(await ui.drawn())
  const at = tree.indexOf('xxxx')
  const end = tree.lastIndexOf('xxxx')
  console.log('CUT TAIL ->', tree.slice(end - 10, end + 220))
  await ui.unmount()
  expect(at).toBeGreaterThan(0)
})

test('G17-9: where do Buttons stop in the drawn tree (real shape, 600 rows)', T, async $ => {
  const ui = await $.ui.mount({ ...PANE, requestId: 'r600-d1-n0-t0-real' } as never)
  const tree = (await ui.drawn()) as { children: { children?: unknown[] }[] }
  const items = tree.children
  console.log('TOP children', items.length)
  const btn = (n: unknown): number => {
    if (typeof n !== 'object' || n === null) return 0
    const x = n as { type?: string; children?: unknown[] }
    return (x.type === 'Button' ? 1 : 0) + (x.children ?? []).reduce((a: number, c) => a + btn(c), 0)
  }
  const per = items.map(btn)
  const firstZero = per.findIndex((c, i) => i > 0 && c === 0)
  console.log('BUTTONS per item (first 3, around cut):', JSON.stringify(per.slice(0, 3)), 'firstZero=', firstZero, JSON.stringify(per.slice(Math.max(0, firstZero - 2), firstZero + 3)))
  const cutItem = items[firstZero]
  console.log('ITEM AT CUT ->', JSON.stringify(cutItem).slice(0, 900))
  const prev = items[firstZero - 1]
  console.log('ITEM BEFORE CUT ->', JSON.stringify(prev).slice(0, 1400))
  await ui.unmount()
})

/** Counts element kinds of the drawn tree, and the ones that "gave way" (a Text holding the "not drawn" words). */
function survivors(tree: unknown): { buttons: number; texts: number; aTexts: number; links: number; boxes: number; gaveWay: number } {
  const o = { buttons: 0, texts: 0, aTexts: 0, links: 0, boxes: 0, gaveWay: 0 }
  const walk = (n: unknown) => {
    if (typeof n === 'string') {
      if (n.includes('not drawn')) o.gaveWay++
      return
    }
    if (typeof n !== 'object' || n === null) return
    const x = n as { type?: string; children?: unknown[] }
    if (x.type === 'Button') o.buttons++
    if (x.type === 'Text') o.texts++
    if (x.type === 'Text' && (x.children ?? []).length === 1 && (x.children ?? [])[0] === 'a') o.aTexts++
    if (x.type === 'Link') o.links++
    if (x.type === 'Box') o.boxes++
    for (const c of x.children ?? []) walk(c)
  }
  walk(tree)
  return o
}

test('G17-10: what counts toward the 100,000-character text budget (calibration)', T, async $ => {
  for (const kind of ['98000-btn-key5', '98000-btn-key50', '98000-btn-label10', '98000-text1', '98000-text1-nokey', '98000-box-key20', '98000-box-nokey', '98000-link40']) {
    const ui = await $.ui.mount({ ...PANE, requestId: `c-${kind}` } as never)
    const s = survivors(await ui.drawn())
    console.log(`CALIB ${kind.padEnd(22)} of 3000 copies -> ${JSON.stringify(s)}`)
    await ui.unmount()
  }
})

/** The first item row whose Buttons are gone: the 100,000-character budget ran out there. -1: none. */
async function cutRow($: Engine, requestId: string): Promise<{ cut: number; items: number }> {
  const ui = await $.ui.mount({ ...PANE, requestId } as never)
  const tree = (await ui.drawn()) as { children: unknown[] }
  const btn = (n: unknown): number => {
    if (typeof n !== 'object' || n === null) return 0
    const x = n as { type?: string; children?: unknown[] }
    return (x.type === 'Button' ? 1 : 0) + (x.children ?? []).reduce((a: number, c) => a + btn(c), 0)
  }
  const per = tree.children.map(btn)
  let cut = -1
  for (let i = 1; i < per.length; i++) {
    if (per[i] === 0 && per[i - 1] !== 0) {
      cut = i
      break
    }
  }
  await ui.unmount()
  return { cut, items: per.length - 1 }
}

test('G17-11: where the 100,000-character budget cuts the rows (first row that loses its Buttons)', T, async $ => {
  for (const id of [
    'r1000-d0-n0-t0',
    'r900-d1-n0-t0',
    'r700-d0-n0-t0-real',
    'r650-d1-n0-t0-real',
    'r700-d0-n0-t0-realkeys',
    'r650-d1-n0-t0-realkeys',
  ]) {
    const c = await cutRow($, id).catch(err => ({ cut: -2, items: String((err as Error).message).replace(/.*refused: /, '') as unknown as number }))
    console.log(`CUTROW ${id.padEnd(26)} first row without Buttons = ${c.cut}  (items drawn ${c.items})`)
  }
})

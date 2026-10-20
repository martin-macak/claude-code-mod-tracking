import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clickUntil } from '../support/click.ts'
import { sleep } from '../support/wait.ts'

// A fake pane: the screen shows the row `row` and the text `selected` once a click has landed. `landsAfterMs` is how long
// after a click the selection shows (Infinity: the click is lost). A click that lands late still lands.
function fake(opts: { landsAfterMs: number[]; spinner?: boolean; arrowAfterMs?: number }) {
  const started = Date.now()
  const clicks: { at: number; column: number; row: number }[] = []
  let frame = 0
  const landedAt = () => {
    const times = clicks.map((c, i) => c.at + (opts.landsAfterMs[i] ?? Number.POSITIVE_INFINITY))
    return Math.min(...times, Number.POSITIVE_INFINITY)
  }
  return {
    clicks,
    capture: () => {
      const shown = Date.now() - started >= (opts.arrowAfterMs ?? 0)
      const lines = [opts.spinner ? `spin ${frame++}` : 'header']
      if (shown) lines.push(Date.now() >= landedAt() ? '│> ▾ three.example' : '│  ▸ three.example')
      return lines.join('\n')
    },
    locate: (screen: string) => (screen.includes('▸') || screen.includes('▾') ? { column: 5, row: 2 } : undefined),
    click: (column: number, row: number) => void clicks.push({ at: Date.now(), column, row }),
    landed: (screen: string) => screen.includes('│> '),
  }
}

const plan = (f: ReturnType<typeof fake>, over: Partial<Parameters<typeof clickUntil>[0]> = {}) => ({
  ...f,
  tries: 3,
  waitMs: 60,
  pollMs: 5,
  what: 'the click did not select the row',
  ...over,
})

test('clickUntil clicks the located arrow once and returns when the row is selected', async () => {
  const f = fake({ landsAfterMs: [20] })
  await clickUntil(plan(f))
  assert.deepEqual(
    f.clicks.map(c => [c.column, c.row]),
    [[5, 2]],
  )
})

test('clickUntil clicks a row that is already selected once: the first click is never skipped', async () => {
  const f = { ...fake({ landsAfterMs: [0] }), landed: () => true }
  await clickUntil(plan(f))
  assert.equal(f.clicks.length, 1)
})

test('clickUntil clicks again when a click was lost', async () => {
  const f = fake({ landsAfterMs: [Number.POSITIVE_INFINITY, 10] })
  await clickUntil(plan(f))
  assert.equal(f.clicks.length, 2)
})

test('clickUntil fails with what it did and the last screen when no click lands', async () => {
  const f = fake({ landsAfterMs: [] })
  await assert.rejects(
    clickUntil(plan(f)),
    /the click did not select the row\n--- screen ---\nheader\n│ {2}▸ three\.example/,
  )
  assert.equal(f.clicks.length, 3)
})

test('clickUntil is not ended by an unrelated change of the screen', async () => {
  // A spinner changes the screen on every read. The old step took that for a landed click and returned.
  const f = fake({ landsAfterMs: [], spinner: true })
  await assert.rejects(clickUntil(plan(f)), /did not select the row/)
  assert.equal(f.clicks.length, 3)
})

test('clickUntil waits for the arrow to show, then clicks it', async () => {
  const f = fake({ landsAfterMs: [5], arrowAfterMs: 30 })
  await clickUntil(plan(f))
  assert.equal(f.clicks.length, 1)
})

test('clickUntil fails without a click when the arrow never shows', async () => {
  const f = fake({ landsAfterMs: [5], arrowAfterMs: Number.POSITIVE_INFINITY })
  await assert.rejects(
    clickUntil(plan(f)),
    /waiting for the arrow to click \(the click did not select the row\)\n--- last screen ---\nheader/,
  )
  assert.equal(f.clicks.length, 0)
})

// The arrow toggles. A click that takes longer than the wait gets a second click, and both land: the row ends closed.
// The state that shows right after the first landing is not final, so the helper waits for it to hold.
function toggler(landsAfterMs: number[]) {
  const clicks: { at: number }[] = []
  const flips = () => clicks.filter((c, i) => Date.now() >= c.at + (landsAfterMs[i] ?? Number.POSITIVE_INFINITY)).length
  return {
    clicks,
    flips,
    capture: () => (flips() % 2 === 1 ? '│> ▾ three.example' : '│  ▸ three.example'),
    locate: () => ({ column: 5, row: 1 }),
    click: () => void clicks.push({ at: Date.now() }),
    landed: (screen: string) => screen.includes('▾'),
  }
}

test('clickUntil does not return while a second toggle is still pending: it waits for the state to hold, then clicks again', async () => {
  // Click 1 lands at 150 ms, after the 100 ms wait, so click 2 goes out at about 100 ms and lands at about 250 ms: closed
  // again. The helper saw the row open at 150 ms and must not return then. The margins are 50 ms or more, so a loaded
  // machine does not change the order of the events.
  const t = toggler([150, 150, 20])
  await clickUntil({ ...t, tries: 3, waitMs: 100, pollMs: 5, settleMs: 250, what: 'the click did not open the row' })
  await sleep(300) // nothing is left in flight: the state stays as the helper left it
  assert.equal(t.clicks.length, 3)
  assert.equal(t.flips() % 2, 1)
})

test('clickUntil with no settle time returns at the first landed state', async () => {
  const t = toggler([10])
  await clickUntil({ ...t, tries: 3, waitMs: 60, pollMs: 5, what: 'the click did not open the row' })
  assert.equal(t.clicks.length, 1)
})

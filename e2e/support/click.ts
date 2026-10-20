import { sleep, waitUntil } from './wait.ts'

export type ClickPlan = {
  /** The screen as it is now. */
  capture: () => string
  /** The 1-based column and row to click on `screen`, or undefined when the target is not there. */
  locate: (screen: string) => { column: number; row: number } | undefined
  click: (column: number, row: number) => void
  /** The post-condition: true once the click had its effect. A change of the screen alone proves nothing. */
  landed: (screen: string) => boolean
  tries: number
  /** How long one click may take to show its effect. */
  waitMs: number
  pollMs?: number
  /** How long `landed` must hold before the helper returns. Default 0: it returns at the first landed screen. */
  settleMs?: number
  /** What the click should have done, for the error. */
  what: string
}

/**
 * Whether `landed` holds now and keeps holding for `settleMs`. A click that toggles can land late, after the helper sent
 * another. The state that shows after the first landing is then not final: the second one flips it back.
 */
async function holds(plan: ClickPlan, pollMs: number): Promise<boolean> {
  const until = Date.now() + (plan.settleMs ?? 0)
  for (;;) {
    if (!plan.landed(plan.capture())) return false
    if (Date.now() >= until) return true
    await sleep(pollMs)
  }
}

/**
 * Clicks until the click has its effect, and fails when it never does. A click that lands while the pane still draws can
 * be lost. A click that toggles must not be sent twice for one effect, so the helper retries only while `landed` is
 * false, never takes a change of the screen (a spinner, a clock) for a landed click, and returns only when `landed` has
 * held for `settleMs`. A late click that undid the first is seen as a state that is not landed any more, and the helper
 * clicks once more: each click is one toggle, so the state converges. Each try finds the target on a fresh screen.
 * The first click is always sent, also when `landed` already holds: the caller asked for a click.
 */
export async function clickUntil(plan: ClickPlan): Promise<void> {
  const pollMs = plan.pollMs ?? 100
  const find = () => plan.locate(plan.capture())
  // The target may still be drawn: wait for it, once, before the first click.
  await waitUntil(find, {
    timeoutMs: plan.waitMs,
    intervalMs: pollMs,
    what: `the arrow to click (${plan.what})`,
    last: plan.capture,
  })
  for (let attempt = 0; attempt < plan.tries; attempt++) {
    const at = find()
    if (at === undefined) break
    plan.click(at.column, at.row)
    const deadline = Date.now() + plan.waitMs
    while (Date.now() < deadline) {
      await sleep(pollMs)
      if (plan.landed(plan.capture()) && (await holds(plan, pollMs))) return
    }
  }
  if (await holds(plan, pollMs)) return
  throw new Error(`${plan.what}\n--- screen ---\n${plan.capture()}`)
}

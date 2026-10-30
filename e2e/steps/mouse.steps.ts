import { When } from '@cucumber/cucumber'
import { clickUntil } from '../support/click.ts'
import { arrowOf, paneTextAt, selectedLine, stripOpenAt } from '../support/pane.ts'
import { sleep } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// One click may take this long to show its effect on a loaded machine, the state must then hold this long, and the step
// sends at most this many clicks.
const WAIT_MS = 3000
const SETTLE_MS = 500
const TRIES = 3

// A click on the arrow of a row. The pane takes a click on a Button only, and the arrow is the Button of the row. A click
// is a press: it selects the row and opens or closes it. A click that lands while the pane still draws its first frames
// can be lost, and one that lands late is followed by another that undoes it, because the click toggles. So the step is
// done when the row is selected and its arrow differs from the one it had before the first click, and that state holds for
// SETTLE_MS (support/click.ts). It fails, with the screen, when it never does.
When('I click the arrow of the row showing {string}', async function (this: DemoWorld, text: string) {
  this.tl.phase('normal')
  let before: string | undefined
  await clickUntil({
    capture: () => this.tmux.capture(),
    locate: screen => {
      const at = arrowOf(screen, text)
      before ??= at?.glyph
      return at
    },
    click: (column, row) => this.tmux.click(column, row),
    landed: screen => {
      const now = arrowOf(screen, text)?.glyph
      return selectedLine(screen)?.includes(text) === true && now !== undefined && now !== before
    },
    tries: TRIES,
    waitMs: WAIT_MS,
    settleMs: SETTLE_MS,
    what: `a click on the arrow of the row showing "${text}" did not select and toggle the row`,
  })
})

// Issue #129. A click on a footer key (`x: dismiss`) or on an `N more` row is a press, and with the keys in the prompt it
// must also give them to the pane: the hint goes. A click that comes at once after the chord that took the keys away is
// lost (live: the handler never ran), so the step waits KEYS_SETTLE_MS first, as the live click runs of the pane did, and
// clicks again only while the hint still shows after WAIT_MS. A click that ran its key and got no keys would run the key
// again, and the step then fails with the screen, as it should. It is done when the hint has gone and stays gone.
const KEYS_HINT = 'Keys go to the prompt.'
const KEYS_SETTLE_MS = 300

When('I click {string} in the pane to give it the keys', async function (this: DemoWorld, text: string) {
  this.tl.phase('normal')
  await sleep(KEYS_SETTLE_MS)
  await clickUntil({
    capture: () => this.tmux.capture(),
    locate: screen => paneTextAt(screen, text),
    click: (column, row) => this.tmux.click(column, row),
    landed: screen => !screen.includes(KEYS_HINT),
    tries: TRIES,
    waitMs: WAIT_MS,
    settleMs: SETTLE_MS,
    what: `a click on "${text}" did not give the pane the keys`,
  })
})

// Issue #69, P2, and #232. A click on the `open` Button of the strip that `ui.turnStrip: interactive` draws under the duration
// line. The click is a press: the pane opens with the keys, the first entry of that turn is selected and every entry that the pane
// lists is marked. A second click on the same turn clears the marks. A click that lands while the line still draws can be lost,
// and a click that lands late is followed by another that undoes it, because the press toggles the marks. So the first step is done
// when the pane selects the row and the view line counts the marks, and the second when no mark is counted: each state must hold
// for SETTLE_MS (support/click.ts). The click is a synthetic SGR click, as in the steps above, not a real mouse.
When(
  'I click the open Button of the strip until the pane selects the row showing {string} and marks {int} rows',
  async function (this: DemoWorld, text: string, marked: number) {
    this.tl.phase('normal')
    await clickUntil({
      capture: () => this.tmux.capture(),
      locate: screen => stripOpenAt(screen),
      click: (column, row) => this.tmux.click(column, row),
      landed: screen =>
        selectedLine(screen)?.includes(text) === true && screen.includes(`View: list · ${marked} marked`),
      tries: TRIES,
      waitMs: WAIT_MS,
      settleMs: SETTLE_MS,
      what: `a click on the open Button of the strip did not make the pane select the row showing "${text}" and mark ${marked} rows`,
    })
  },
)

When('I click the open Button of the strip again until the pane marks no row', async function (this: DemoWorld) {
  this.tl.phase('normal')
  await clickUntil({
    capture: () => this.tmux.capture(),
    locate: screen => stripOpenAt(screen),
    click: (column, row) => this.tmux.click(column, row),
    landed: screen => screen.includes('View: list') && !/\d+ marked/.test(screen),
    tries: TRIES,
    waitMs: WAIT_MS,
    settleMs: SETTLE_MS,
    what: 'a second click on the open Button of the strip did not clear the marks of its turn',
  })
})

import { When } from '@cucumber/cucumber'
import { clickUntil } from '../support/click.ts'
import { arrowOf, selectedLine } from '../support/pane.ts'
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

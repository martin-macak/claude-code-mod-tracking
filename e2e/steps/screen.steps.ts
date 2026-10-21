import { defineParameterType, Then, When } from '@cucumber/cucumber'
import { focusedTexts, paneShows, placementOf, refreshAge, selectedLine } from '../support/pane.ts'
import { PERMISSION_MARKERS } from '../support/session.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

defineParameterType({ name: 'regex', regexp: /\/(.*)\//, transformer: (source: string) => new RegExp(source, 'm') })

Then('the screen shows {string}', async function (this: DemoWorld, text: string) {
  await this.waitScreen(screen => screen.includes(text), `the screen to show "${text}"`)
})

Then('the screen matches {regex}', async function (this: DemoWorld, re: RegExp) {
  await this.waitScreen(screen => re.test(screen), `the screen to match ${re}`)
})

Then('the screen stops showing {string}', async function (this: DemoWorld, text: string) {
  await this.waitScreen(screen => !screen.includes(text), `the screen to stop showing "${text}"`)
})

// Issue #165. The transcript beside the pane can hold the words of a row that the pane dropped: the `/track` line still says
// `#7`. A step that asks whether the pane stopped showing a row reads the pane only (support/pane.ts, `paneShows`), and
// `the screen stops showing` is for text that no part of the screen keeps.
Then('the pane stops showing {string}', async function (this: DemoWorld, text: string) {
  await this.waitScreen(screen => !paneShows(screen, text), `the pane to stop showing "${text}"`)
})

Then('the screen does not show {string}', function (this: DemoWorld, text: string) {
  const screen = this.tmux.capture()
  if (screen.includes(text)) throw new Error(`the screen shows "${text}"\n--- screen ---\n${screen}`)
})

// The pane starts a row with a gutter: ">" marks the selected row (support/pane.ts).
Then('the selected row shows {string}', async function (this: DemoWorld, text: string) {
  await this.waitScreen(screen => selectedLine(screen)?.includes(text) === true, `the selected row to show "${text}"`)
})

// Where Claude Code seats the pane depends on the width of the terminal: docked beside the transcript, or inline under it
// (support/pane.ts). A scenario that runs at two sizes says which one it expects, so a size that did not take effect fails.
const PLACEMENTS = ['docked', 'inline']
Then('the pane is {word}', async function (this: DemoWorld, placement: string) {
  if (!PLACEMENTS.includes(placement))
    throw new Error(`the pane is "${placement}": use one of ${PLACEMENTS.join(', ')}`)
  await this.waitScreen(screen => placementOf(screen) === placement, `the pane to be ${placement}`)
})

// The focus ring draws the focused Button in reverse video. The selected row follows the focus over the rows, but the
// "N more" Button holds no selection: only its reverse video shows that a Tab has reached it.
Then('the focus ring is on {string}', async function (this: DemoWorld, text: string) {
  await this.waitScreen(
    screen => focusedTexts(screen).some(focused => focused.includes(text)),
    `the focus ring to be on "${text}"`,
    { ansi: true },
  )
})

Then('no permission dialog is open', function (this: DemoWorld) {
  const screen = this.tmux.capture()
  if (PERMISSION_MARKERS.some(re => re.test(screen))) {
    throw new Error(`a permission dialog is open; use a prompt that needs no tools\n--- screen ---\n${screen}`)
  }
})

// Issue #165. The pane draws how old the last refresh is when it draws, and not again by itself. A scenario that asks
// whether a key refreshed compares two ages that the screen showed, the one before the key and the one after it, and not
// the words `just now`: those say "less than a second", and a machine that is slow to draw can make a fresh refresh older.
// The noted age is a field of the world (`notedRefreshAge`), like the other state of one scenario.

// The age of the last refresh as the screen shows it now. The age must be some seconds: the scenario waits for the log of
// the fake gh to be quiet before it draws, and a `just now` here means it did not wait long enough, not that it is fine.
When('I note how old the last refresh on the screen is', async function (this: DemoWorld) {
  this.tl.phase('fast')
  const age = await waitUntil(() => refreshAge(this.tmux.capture()), {
    timeoutMs: this.config.screenTimeoutMs,
    what: 'a section note that says how old the last refresh is',
    last: () => this.tmux.capture(),
  })
  this.tl.phase('normal')
  if (age < 1) {
    throw new Error(
      `the last refresh is "just now": no key can make it younger\n--- screen ---\n${this.tmux.capture()}`,
    )
  }
  this.notedRefreshAge = age
})

Then('the last refresh on the screen is younger than the one noted', async function (this: DemoWorld) {
  const before = this.notedRefreshAge
  if (before === undefined)
    throw new Error('no age was noted: use the step "I note how old the last refresh on the screen is" first')
  await this.waitScreen(
    screen => (refreshAge(screen) ?? Number.POSITIVE_INFINITY) < before,
    `the last refresh to be younger than ${before}s`,
  )
})

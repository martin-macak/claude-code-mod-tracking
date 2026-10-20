import { defineParameterType, Then } from '@cucumber/cucumber'
import { focusedTexts, selectedLine } from '../support/pane.ts'
import { PERMISSION_MARKERS } from '../support/session.ts'
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

Then('the screen does not show {string}', function (this: DemoWorld, text: string) {
  const screen = this.tmux.capture()
  if (screen.includes(text)) throw new Error(`the screen shows "${text}"\n--- screen ---\n${screen}`)
})

// The pane starts a row with a gutter: ">" marks the selected row (support/pane.ts).
Then('the selected row shows {string}', async function (this: DemoWorld, text: string) {
  await this.waitScreen(screen => selectedLine(screen)?.includes(text) === true, `the selected row to show "${text}"`)
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

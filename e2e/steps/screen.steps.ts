import { defineParameterType, Then } from '@cucumber/cucumber'
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

Then('no permission dialog is open', function (this: DemoWorld) {
  const screen = this.tmux.capture()
  if (PERMISSION_MARKERS.some(re => re.test(screen))) {
    throw new Error(`a permission dialog is open; use a prompt that needs no tools\n--- screen ---\n${screen}`)
  }
})

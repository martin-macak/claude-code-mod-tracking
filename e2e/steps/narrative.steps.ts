import { Given } from '@cucumber/cucumber'
import type { DemoWorld } from '../support/world.ts'

Given('the caption {string}', function (this: DemoWorld, text: string) {
  this.tmux.caption(text)
})

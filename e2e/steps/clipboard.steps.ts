import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Given, Then } from '@cucumber/cucumber'
import {
  assertStampUnchanged,
  CLIPBOARD_TOOLS,
  capturedBy,
  clipboardRoutes,
  pasteboardStamp,
} from '../support/clipboard-guard.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// The other way to check the copy key (issue #207): no probe answers the event, so the engine takes its own routes. The clipboard
// of the machine is guarded (support/clipboard-guard.ts) and the steps below read what reached the tmux buffer of the private
// socket and the shims of the clipboard tools. Put the step before the step that starts the session.
Given('the clipboard of this machine is guarded', function (this: DemoWorld) {
  this.guardClipboard()
})

Then('the tmux buffer is empty', function (this: DemoWorld) {
  const buffer = this.tmux.buffer()
  if (buffer !== undefined) throw new Error(`the tmux buffer is not empty: ${JSON.stringify(buffer.slice(0, 200))}`)
})

Then('the tmux buffer holds {string}', async function (this: DemoWorld, text: string) {
  await waitUntil(() => (this.tmux.buffer()?.includes(text) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the tmux buffer to hold "${text}"`,
    last: () => JSON.stringify(this.tmux.buffer() ?? null),
  })
})

// A clipboard tool the engine started (a shim of the guard) got the text on its input.
Then('a clipboard tool got {string}', async function (this: DemoWorld, text: string) {
  const guard = this.clipboardGuard
  if (guard === undefined) throw new Error('a clipboard tool got: the clipboard is not guarded in this scenario')
  const got = () =>
    CLIPBOARD_TOOLS.map(tool => [tool, capturedBy(guard, tool)] as const).find(([, t]) => t?.includes(text))
  await waitUntil(() => got(), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `a clipboard tool to get "${text}"`,
    last: () => JSON.stringify(CLIPBOARD_TOOLS.map(tool => [tool, capturedBy(guard, tool) ?? null])),
  })
})

// The routes that took the text: the tmux buffer, and each clipboard tool the engine started. The file is in the folder of the
// scenario (e2e/out), and the KB cites it.
Then('the routes of the copy are noted', function (this: DemoWorld) {
  const guard = this.clipboardGuard
  if (guard === undefined) throw new Error('the routes of the copy: the clipboard is not guarded in this scenario')
  const routes = clipboardRoutes(guard, this.tmux.buffer())
  writeFileSync(join(this.outDir, 'tmux-buffer.txt'), this.tmux.buffer() ?? '')
  writeFileSync(join(this.outDir, 'clipboard-routes.json'), `${JSON.stringify(routes, null, 2)}\n`)
})

// The clipboard of the machine was not written (issue #207, R2). The counter of the pasteboard holds no content. Where no
// counter exists (not macOS), the step checks nothing but the tmux clients. A client of the private server would receive the
// OSC 52 write and pass it to its terminal.
Then('the clipboard of this machine did not change', function (this: DemoWorld) {
  if (this.clipboardGuard === undefined) throw new Error('the clipboard is not guarded in this scenario')
  const clients = this.tmux.clients()
  if (clients.length > 0)
    throw new Error(`a tmux client is attached (${clients.join(', ')}): it would pass the OSC 52 write on`)
  assertStampUnchanged(this.clipboardStampBefore, pasteboardStamp())
})

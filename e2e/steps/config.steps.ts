import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Given, Then } from '@cucumber/cucumber'
import { CONFIG_FILE } from '../support/config-dir.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// The file text, or undefined while it is missing.
function readText(world: DemoWorld): string | undefined {
  try {
    return readFileSync(join(world.configDir, CONFIG_FILE), 'utf8')
  } catch {
    return undefined
  }
}

// The value at a dotted path, or undefined when the text is not JSON or the path leads nowhere.
function valueAt(text: string | undefined, path: string): unknown {
  let node: unknown
  try {
    node = text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined // The mod may be in the middle of its write.
  }
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

// Before the session starts. The folder is this scenario's CLAUDE_TRACKER_CONFIG_DIR (world.ts).
Given('the tracker config file:', function (this: DemoWorld, text: string) {
  this.tl.phase('cut')
  writeFileSync(join(this.configDir, CONFIG_FILE), text)
})

// Before the step that writes the config file and the step that starts the session. The help view of the pane prints
// the path of the config file, and the rows that it takes depend on the width of that path. The temporary folder of
// a system is as wide as it is, so a scenario that counts those rows sets the width (support/config-dir.ts).
Given('the tracker config file path is {int} cells wide', function (this: DemoWorld, cells: number) {
  this.setConfigPathWidth(cells)
})

// The value is JSON text: "30000", "true", "false" or a quoted string.
Then('the tracker config file sets {string} to {string}', async function (this: DemoWorld, path: string, json: string) {
  const want: unknown = JSON.parse(json)
  this.tl.phase('fast')
  await waitUntil(() => (isDeepStrictEqual(valueAt(readText(this), path), want) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the config file to set ${path} to ${json}`,
    last: () => `config file: ${readText(this) ?? '(missing)'}\n--- screen ---\n${this.tmux.capture()}`,
  })
  this.tl.phase('normal')
})

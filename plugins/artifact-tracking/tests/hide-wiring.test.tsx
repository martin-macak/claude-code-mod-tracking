// Kit test of hiding ended rows through the real hooks (issue #49, PR 1): the TTL from the config file, the hidden count
// in the `/track` text, `/track show-all` on the engine atom `hidden`, and `/clear`, which resets the atom as it resets
// every `$.state` member. The rest of the rules run in tests/hide-ended.test.ts over fake ports.

import { expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { clearSession, quiet, START, track, world } from './fixtures/world'

/** The config file under `HOME = /home/u`. */
const C = '/home/u/.config/claude-code/mods/tracker/config.json'
/** `endedTtlMs: 0`: a row hides the moment it ends, so the test needs no clock. */
const FILE = JSON.stringify({ version: 1, trackers: { processes: { endedTtlMs: 0 } } })

test('an ended process row is hidden after its TTL, /track show-all brings it back, and /clear hides it again', async ($, on) => {
  const w = world(on, { isolateState: true, disk: { [C]: FILE } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  w.fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' }
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', tool_use_id: 'toolu_bg_1' } as never)
  await quiet(w.calls)
  expect((await track($)).text).toContain('npm run dev') // running: shown

  await $.session.append({
    door: 'prompt',
    origin: { kind: 'task-notification' },
    uuid: 'u-task-1',
    task: { id: 'task-bg-1', status: 'completed', toolUseId: 'toolu_bg_1' },
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'done' }] },
  } as never)
  const hidden = (await track($)).text ?? ''
  expect(hidden).not.toContain('npm run dev')
  expect(hidden).toMatch(/Processes\s+0 tracked \(1 hidden\)/)

  // The first start already wrote the new keys into the file, so count the writes around the toggle: any file write fails.
  const writes = w.fake.fsWrites.length
  const shown = (await track($, 'show-all')).text ?? ''
  expect(shown).toContain('Showing all rows.')
  expect(shown).toContain('npm run dev')
  expect(shown).toMatch(/Processes\s+1 tracked/)
  expect(w.fake.fsWrites).toHaveLength(writes) // show-all wrote no file, config.json included

  await clearSession($, w, 'sess-2', 'clear') // the row is carried over, the atom is not
  expect((await track($)).text).not.toContain('npm run dev')
})

// The real ConfigManager over a fake file, with the real PromptRebuild: an edit of `prompt.maxItems`, a setting that
// no switch turns on or off, changes the text at the next tick, and at `/track`, with no turn and no data change.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11 (config change). Plan: L7 Task 6 (S14).
import { expect, test } from 'claude-code/testing'
import { ConfigManager } from '../core/infra/config-manager'
import { PROMPT_FRAME, PROMPT_SECTION_ID } from '../core/infra/prompt'
import type { EnvName } from '../core/interfaces/ports'
import type { Tracker } from '../core/interfaces/tracker'
import { fakeConfigFs } from './fixtures/config-fs'
import { managerWorld } from './fixtures/manager'

const P = '/h/.config/claude-code/mods/tracker/config.json'
const file = (maxItems: number): string =>
  JSON.stringify({ version: 1, trackers: { a: { prompt: { enabled: true, maxItems } } } })

test('editing prompt.maxItems in the config file changes the text at the next tick and at /track', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `a: item ${i + 1}`)
  // The raw slice stands: `promptSettings` checks the prompt block, as for a real tracker.
  const tracker: Tracker = {
    id: 'a',
    order: 10,
    config: { defaults: {}, normalise: raw => raw },
    init: () => {},
    store: ctx => ctx.config.slice(),
    prompt: () => lines,
  }
  const fs = fakeConfigFs({ [P]: file(5) })
  const { w, m } = managerWorld({
    trackers: () => [],
    extra: [tracker],
    config: specs =>
      new ConfigManager({
        fs: fs.fs,
        env: { get: async (name: EnvName) => (name === 'HOME' ? '/h' : undefined) },
        specs,
        log: () => {},
      }),
  })
  const text = (): string | undefined => m.compose({ traits: [] }, []).find(s => s.id === PROMPT_SECTION_ID)?.text
  await m.start(w.ports, { fromSessionStart: true })
  expect(text()).toBe(`${PROMPT_FRAME}\n${lines.slice(0, 4).join('\n')}\na: and 8 more not listed`)
  // The person edits the file: no turn, no data change, no command.
  fs.edit(P, file(50))
  await w.clock.advance(31_000)
  expect(text()).toBe(`${PROMPT_FRAME}\n${lines.join('\n')}`)
  // Down again, and `/track` is the reader this time: it reads the file too.
  fs.edit(P, file(6))
  await m.track(w.ports, 'help')
  expect(text()).toBe(`${PROMPT_FRAME}\n${lines.slice(0, 5).join('\n')}\na: and 7 more not listed`)
})

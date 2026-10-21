// Kit tests of the config file (L4): the first-run write, the path rule, a disabled tracker, an invalid file, a refused
// write and a live edit, each through the real hooks over the Map-backed stub disk of `world` (spec section 7).
// New behavior goes in this file, so the older wiring tests keep their cases.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 7. Plan: L4 Task 10.

import { expect, mock } from 'claude-code/testing'
import { PROCESSES_DEFAULTS } from '../trackers/processes/config'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { graphqlCalls, prompt, quiet, SESSION, START, track, until, world } from './fixtures/world'

/** The config file under `HOME = /home/u`. */
const C = '/home/u/.config/claude-code/mods/tracker/config.json'
const IDS = ['github', 'jira', 'web', 'artifact', 'file', 'repos', 'processes', 'auto']

/** The config file as a Claude Code user writes it: strict JSON. */
const file = (trackers: Record<string, unknown> = {}) => JSON.stringify({ version: 1, trackers })
/** The one file the mod wrote, parsed. */
const written = (w: { fake: { fsWrites: { path: string; text: string }[] } }, at = 0) =>
  JSON.parse(w.fake.fsWrites[at]!.text) as {
    version: number
    global: { refresh: { tickMs: number; captureDebounceMs: number } }
    trackers: Record<string, { enabled: boolean }>
  }

test('first start writes the default config file once', async ($, on) => {
  const w = world(on)
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  expect(w.fake.fsWrites.length).toBe(1)
  expect(w.fake.fsWrites[0]!.path).toBe(C)
  const doc = written(w)
  expect(doc.version).toBe(1)
  expect(Object.keys(doc.trackers)).toEqual(IDS)
  expect(doc.global.refresh.tickMs).toBe(30000)
  expect(w.fake.fsWrites[0]!.text.endsWith('}\n')).toBe(true)
  await $.session.start(START)
  expect(w.fake.fsWrites.length).toBe(1)
})

test('no HOME: no fs call for the config file', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await track($)
  expect(w.fake.fsCalls.filter(c => c.endsWith('config.json'))).toEqual([])
  expect(w.fake.fsWrites).toEqual([])
})

test('CLAUDE_TRACKER_CONFIG_DIR names the folder', async ($, on) => {
  const w = world(on)
  mock.env(on, { CLAUDE_TRACKER_CONFIG_DIR: '/cfg/t', HOME: '/home/u' })
  await $.session.start(START)
  expect(w.fake.fsWrites.map(x => x.path)).toEqual(['/cfg/t/config.json'])
})

test('web off: a web link is not tracked, a GitHub item is, and /track shows no Web links', async ($, on) => {
  const w = world(on, { disk: { [C]: '{ "version": 1, "trackers": { "web": { "enabled": false } } }' } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  await $.session.append(prompt('see https://github.com/acme/web/issues/5 and https://example.com/a'))
  await w.clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(w.calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('GitHub')
  expect(text).not.toContain('Web links')
  expect(text).not.toContain('example.com')
  // The first start completed the file: the user's off switch stays, the global block and the other slices come in.
  const doc = written(w)
  expect(doc.trackers.web).toEqual({ enabled: false, prompt: { enabled: false, maxItems: 20 } })
  expect(doc.global.refresh.tickMs).toBe(30000)
  expect(doc.trackers.github!.enabled).toBe(true)
})

test('processes off: a background Bash task adds no process row', async ($, on) => {
  const w = world(on, { disk: { [C]: file({ processes: { enabled: false } }) } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  w.fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' }
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', tool_use_id: 'toolu_bg_1' } as never)
  await quiet(w.calls)
  const text = (await track($)).text ?? ''
  expect(text).not.toContain('Processes')
  expect(text).not.toContain('npm run dev')
  expect(written(w).trackers.processes).toEqual({
    ...PROCESSES_DEFAULTS,
    enabled: false,
  })
})

test('an invalid file: /track shows the problem and the file is not written', async ($, on) => {
  const w = world(on, { disk: { [C]: '{ "version": 1, }' } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toMatch(
    /\n\nConfig problems in \/home\/u\/\.config\/claude-code\/mods\/tracker\/config\.json:\n {2}The file is not valid JSON: .+\. The mod keeps the last good values and does not change the file\.$/,
  )
  expect(w.fake.fsWrites).toEqual([])
  expect(w.fake.disk.get(C)).toBe('{ "version": 1, }')
})

test('a refused write shows one problem and the session goes on', async ($, on) => {
  const w = world(on, { denyFs: { write: 'EACCES: permission denied' } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  // The engine names the plugin and the call in a refusal. The mod quotes the reason only (copy F4).
  const block = `\n\nConfig problems in ${C}:\n  The mod cannot write the file: EACCES: permission denied. It tries again at the next start.`
  expect((await track($)).text).toBe('No tracked items yet.' + block)
  // The session goes on: a later web row still tracks, and the problem shows once.
  await $.session.append(prompt('see https://example.com/a'))
  await w.clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(w.calls)
  const again = (await track($)).text ?? ''
  expect(again).toContain('Web links')
  expect(again.endsWith(block)).toBe(true)
  expect(again.split('The mod cannot write the file').length).toBe(2)
  expect(w.fake.fsWrites).toEqual([])
  expect(w.fake.fsCalls.filter(c => c === `write ${C}`).length).toBe(1) // no second try in this load
})

test('session.end as the first hook writes no config file', async ($, on) => {
  const w = world(on)
  mock.env(on, { HOME: '/home/u' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION } as never)
  expect(w.fake.fsWrites).toEqual([])
})

test('an edited file reaches the next tick', async ($, on) => {
  const w = world(on)
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  expect(w.fake.fsWrites.length).toBe(1)
  const doc = written(w)
  doc.global.refresh.captureDebounceMs = 5000
  w.fake.editDisk(C, JSON.stringify(doc, null, 2) + '\n')
  await w.clock.advance(LIMITS.tickMs + 10) // the tick reads the edit
  await quiet(w.calls)
  expect(graphqlCalls(w.calls).length).toBe(0)
  await $.session.append(prompt('see https://github.com/acme/web/issues/5'))
  await w.clock.advance(1010)
  await quiet(w.calls)
  expect(graphqlCalls(w.calls).length).toBe(0) // the old delay (1 s) has passed, the new one (5 s) has not
  await w.clock.advance(4000)
  await quiet(w.calls)
  await until(() => graphqlCalls(w.calls).length > 0, 'the refresh after the new capture debounce')
  expect(graphqlCalls(w.calls).length).toBe(1)
  expect(w.fake.fsWrites.length).toBe(1) // the edit is the user's: the mod never wrote over it
})

// The cap on the config problems (issue #144), through the real hooks: the mod shows 50 and a count, the log holds all.
/** A file whose `global` block holds `n` unknown keys: one problem each. */
const unknownKeys = (n: number) =>
  JSON.stringify({ version: 1, global: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i])) })
const UNKNOWN_KEY = ': unknown key. The mod keeps it and ignores it.'

test('5000 unknown keys: /track lists ten problems and counts the other 4990, and the debug log holds all 5000', async ($, on) => {
  const w = world(on, { disk: { [C]: unknownKeys(5000) } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const lines = ((await track($)).text ?? '').split('\n')
  expect(lines.slice(-12)).toEqual([
    `Config problems in ${C}:`,
    ...Array.from({ length: 10 }, (_, i) => `  global.k${i}${UNKNOWN_KEY}`),
    '  and 4990 more problems: see /track help.',
  ])
  const logged = w.fake.logs.filter(l => l.text.startsWith('config: global.k'))
  expect(logged).toHaveLength(5000)
  expect(new Set(logged.map(l => l.to))).toEqual(new Set(['debug']))
  expect(w.fake.logs.some(l => l.text.includes('more problems'))).toBe(false)
})

test('60 unknown keys and a refused write: /track names the refused write first, inside the 50', async ($, on) => {
  const w = world(on, { disk: { [C]: unknownKeys(60) }, denyFs: { write: 'EACCES: permission denied' } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const lines = ((await track($)).text ?? '').split('\n')
  expect(lines.slice(-12)).toEqual([
    `Config problems in ${C}:`,
    '  The mod cannot write the file: EACCES: permission denied. It tries again at the next start.',
    ...Array.from({ length: 9 }, (_, i) => `  global.k${i}${UNKNOWN_KEY}`),
    '  and 51 more problems: see /track help.',
  ])
  const help = ((await track($, 'help')).text ?? '').split('\n')
  expect(help.slice(help.indexOf('Problems') + 1).at(-1)).toBe(
    '  11 more problems: see /home/u/.claude/debug/latest (claude --debug)',
  )
  expect(w.fake.logs.filter(l => l.text.startsWith('config: '))).toHaveLength(61)
})

test('60 unknown keys: /track help prints the first 50 problems, then one line that counts the other 10', async ($, on) => {
  const w = world(on, { disk: { [C]: unknownKeys(60) } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const lines = ((await track($, 'help')).text ?? '').split('\n')
  const problems = lines.slice(lines.indexOf('Problems') + 1)
  expect(problems).toHaveLength(51)
  expect(problems[0]).toBe(`  global.k0${UNKNOWN_KEY}`)
  expect(problems[49]).toBe(`  global.k49${UNKNOWN_KEY}`)
  expect(problems[50]).toBe('  10 more problems: see /home/u/.claude/debug/latest (claude --debug)')
  expect(w.fake.logs.filter(l => l.text.startsWith('config: global.k'))).toHaveLength(60)
})

test('50 unknown keys: /track help prints all 50 and no count line', async ($, on) => {
  world(on, { disk: { [C]: unknownKeys(50) } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const lines = ((await track($, 'help')).text ?? '').split('\n')
  const problems = lines.slice(lines.indexOf('Problems') + 1)
  expect(problems).toHaveLength(50)
  expect(problems.some(p => p.includes('more problem'))).toBe(false)
})

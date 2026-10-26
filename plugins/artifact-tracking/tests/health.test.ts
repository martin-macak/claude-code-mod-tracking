// The health line of the pane (issue #138, owner decision Q4 of the delta study,
// https://github.com/martin-macak/claude-code-mod-tracking/issues/138#issuecomment-6412630538): each tool of the trackers that run,
// in the words of a section note, then the count of the problems that the help view lists. Pure.
import { expect, test } from 'claude-code/testing'
import { KeyRegistry } from '../core/infra/keys'
import { healthLine } from '../core/lib/health'
import { toolNote, toolState } from '../core/lib/text'
import { helpOf, problemCount } from '../hooks/pane-text'
import type { ToolStatus } from '../types'
import { fakeConfig } from './fixtures/config-fs'

const NOW = 1_000_000
const ready = (name: string): ToolStatus => ({ name, available: true, loggedIn: true, breaker: 'closed' })
const missing = (name: string): ToolStatus => ({ name, available: false, loggedIn: null, breaker: 'closed' })
/** The tools, then the problem count: the tail of the line, which keeps its room when the line is clipped. */
const words = (line: ReturnType<typeof healthLine>): string[] =>
  [...line.cells, ...(line.tail === undefined ? [] : [line.tail])].map(c => c.text)

test('healthLine names each tool with the note of a section, then the problem count', () => {
  const line = healthLine(
    [
      { id: 'acli', status: missing('acli') },
      { id: 'gh', status: ready('gh') },
    ],
    NOW,
    2,
  )
  expect(line.label).toBe('Health:')
  expect(words(line)).toEqual(['acli not installed', 'gh ready', '2 problems: h'])
})

test('healthLine says the other notes of a tool: not logged in, paused, checking', () => {
  const line = healthLine(
    [
      { id: 'gh', status: { name: 'gh', available: true, loggedIn: false, breaker: 'closed' } },
      {
        id: 'acli',
        status: { name: 'acli', available: true, loggedIn: true, breaker: 'open', openUntil: NOW + 120_000 },
      },
      { id: 'idle', status: { name: 'idle', available: null, loggedIn: null, breaker: 'closed' } },
    ],
    NOW,
    0,
  )
  expect(words(line)).toEqual(['gh not logged in', 'acli paused 2m', 'idle checking…', 'no problems'])
})

test('healthLine says one problem in the singular, and no problem as such', () => {
  expect(words(healthLine([], NOW, 1))).toEqual(['1 problem: h'])
  expect(words(healthLine([], NOW, 0))).toEqual(['no problems'])
})

test('healthLine with no tool of a live tracker is the problem count alone', () => {
  expect(words(healthLine([], NOW, 3))).toEqual(['3 problems: h'])
})

test('healthLine leaves out a tool that the state does not know, and colors what needs the person', () => {
  const line = healthLine(
    [
      { id: 'ghost', status: undefined },
      { id: 'acli', status: missing('acli') },
      { id: 'gh', status: ready('gh') },
    ],
    NOW,
    2,
  )
  expect(words(line)).toEqual(['acli not installed', 'gh ready', '2 problems: h'])
  expect([...line.cells, line.tail].map(c => c?.fg)).toEqual(['warning', undefined, 'warning'])
  expect(healthLine([], NOW, 0).tail?.dim).toBe(true)
})

test('healthLine puts the problem count in the tail, so a narrow pane cuts a tool note and never the count', () => {
  const line = healthLine([{ id: 'gh', status: ready('gh') }], NOW, 2)
  expect(line.cells.map(c => c.text)).toEqual(['gh ready'])
  expect(line.tail?.text).toBe('2 problems: h')
})

// The color of a tool and its words are one fact (review m3): a state that toolNote words must color the same way.
const STATES: readonly [string, ToolStatus, string, boolean][] = [
  ['not installed', missing('x'), 'not installed', true],
  ['not logged in', { name: 'x', available: true, loggedIn: false, breaker: 'closed' }, 'not logged in', true],
  [
    'paused',
    { name: 'x', available: true, loggedIn: true, breaker: 'open', openUntil: NOW + 120_000 },
    'paused 2m',
    true,
  ],
  ['checking', { name: 'x', available: null, loggedIn: null, breaker: 'closed' }, 'checking…', false],
  ['ready', ready('x'), 'ready', false],
]

test('toolState gives the words of toolNote and whether the person must act, from one place', () => {
  for (const [name, status, note, needsPerson] of STATES) {
    expect(toolState(status, NOW), name).toEqual({ note, needsPerson })
    expect(toolNote(status, NOW), name).toBe(note)
  }
  expect(toolState(ready('x'), NOW, NOW - 90_000)).toEqual({ note: 'refreshed 1m ago', needsPerson: false })
})

test('healthLine colors a tool in the warning color exactly when its note says the person must act', () => {
  for (const [name, status, note, needsPerson] of STATES) {
    const cell = healthLine([{ id: 'x', status }], NOW, 0).cells[0]
    expect(cell?.text, name).toBe(`x ${note}`)
    expect(cell?.fg, name).toBe(needsPerson ? 'warning' : undefined)
  }
})

const host = (problems: string[], keyProblems: string[]) => ({
  config: fakeConfig({ problems }),
  problems: () => keyProblems,
  keys: new KeyRegistry(),
  version: undefined,
})

test('problemCount adds the config problems and the key problems', () => {
  expect(problemCount(host([], []))).toBe(0)
  expect(problemCount(host(['config: a', 'config: b'], ['keys: c']))).toBe(3)
})

test('problemCount counts the problems that the config left out of its 50, as the compact help view does', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => `config: problem ${i}`)
  expect(problemCount(host(sixty, ['keys: c']))).toBe(61)
})

test('problemCount is the count of the help view: its problems and the ones the config left out', () => {
  for (const config of [[], ['config: a'], Array.from({ length: 53 }, (_, i) => `config: p${i}`)]) {
    const h = host(config, ['keys: x', 'trackers.t: failed'])
    const model = helpOf(h, [])
    expect(problemCount(h), String(config.length)).toBe(model.problems.length + (model.moreProblems?.count ?? 0))
  }
})

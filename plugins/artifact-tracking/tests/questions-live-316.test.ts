// What the questions tracker reads of the captures of Claude Code 2.1.316 (issue #208, tests/fixtures/questions-live-316.ts): the
// text and number forms, "Chat about this", an away dialog, a `ui.ask` of a second plugin, and the way the engine quotes the
// pieces of a multi-select answer. The captures are in docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-01.
import { expect, test } from 'claude-code/testing'
import { answerParts, askCall } from '../trackers/questions/parse'
import {
  LIVE_AFK,
  LIVE_CHAT_ABOUT_THIS,
  LIVE_COMMA_LABEL,
  LIVE_PLUGIN_ASK,
  LIVE_QUOTE_ONLY,
  LIVE_QUOTE_PIECE,
  LIVE_TEXT_NUMBER,
} from './fixtures/questions-live-316'

test('a text and a number question answer a plain string each, and the mod keeps the control', () => {
  const call = askCall(LIVE_TEXT_NUMBER)
  expect(call).toMatchObject({ state: 'answered' })
  const [name, slides] = call?.items ?? []
  expect(name).toMatchObject({ kind: 'text', placeholder: 'my-project', answer: 'acme-app' })
  expect(slides).toMatchObject({
    kind: 'number',
    min: 1,
    max: 20,
    step: 1,
    defaultValue: 5,
    unit: 'slides',
    answer: '12',
  })
  if (name !== undefined) expect(answerParts(name)).toEqual({ chosen: [], typed: ['acme-app'], notesOnly: false })
  if (slides !== undefined) expect(answerParts(slides)).toEqual({ chosen: [], typed: ['12'], notesOnly: false })
})

test('"Chat about this" in the terminal is a declined call with the words of the engine, and no follow-up', () => {
  const call = askCall(LIVE_CHAT_ABOUT_THIS)
  expect(call).toMatchObject({ state: 'declined' })
  expect(call?.refusal).toContain('The user wants to clarify these questions.')
  expect(call).not.toHaveProperty('followUp')
  expect(call).not.toHaveProperty('response')
})

test('an away dialog has no answer, and keeps the timeout', () => {
  const call = askCall(LIVE_AFK)
  expect(call).toMatchObject({ state: 'partial', afkTimeoutMs: 8000 })
  expect(call?.items?.[0]).not.toHaveProperty('answer')
})

test('a ui.ask of a second plugin is marked by its id, and no field of the call names the plugin', () => {
  const call = askCall(LIVE_PLUGIN_ASK)
  expect(call).toMatchObject({ plugin: true, state: 'answered' })
  expect(call?.id).toMatch(/^toolu_plugin_[0-9a-f]{32}$/)
  expect(call?.items?.[0]?.answer).toBe('Blue')
  expect(Object.keys(call ?? {}).sort()).toEqual(['id', 'items', 'kind', 'plugin', 'state'])
})

test('a picked label with a comma is quoted by the engine, next to a typed piece', () => {
  const [q] = askCall(LIVE_COMMA_LABEL)?.items ?? []
  expect(q?.answer).toBe('A, "A, custom", typed piece')
  if (q !== undefined)
    expect(answerParts(q)).toEqual({ chosen: ['A', 'A, custom'], typed: ['typed piece'], notesOnly: false })
})

test('a typed piece with a quote and a comma is a JSON string, and reads back whole', () => {
  const [q] = askCall(LIVE_QUOTE_PIECE)?.items ?? []
  expect(q?.answer).toBe('Lint, "say \\"hi\\", ok"')
  if (q !== undefined) expect(answerParts(q)).toEqual({ chosen: ['Lint'], typed: ['say "hi", ok'], notesOnly: false })
})

test('a piece with a quote and no comma is quoted, a piece with a backslash is plain, a single typed answer is never quoted', () => {
  const [quote, backslash, single] = askCall(LIVE_QUOTE_ONLY)?.items ?? []
  expect(quote?.answer).toBe('Lint, "a \\"q\\" b"')
  expect(backslash?.answer).toBe('Lint, c\\d')
  expect(single?.answer).toBe('x, "y"')
  if (quote !== undefined)
    expect(answerParts(quote)).toEqual({ chosen: ['Lint'], typed: ['a "q" b'], notesOnly: false })
  if (backslash !== undefined)
    expect(answerParts(backslash)).toEqual({ chosen: ['Lint'], typed: ['c\\d'], notesOnly: false })
  if (single !== undefined) expect(answerParts(single)).toEqual({ chosen: [], typed: ['x, "y"'], notesOnly: false })
})

test('a quoted piece reads as a JSON string: an escaped quote before a comma does not end it', () => {
  const q = { question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'D' }] }
  expect(answerParts({ ...q, answer: 'A, "he said \\"no\\", twice", D' })).toEqual({
    chosen: ['A', 'D'],
    typed: ['he said "no", twice'],
    notesOnly: false,
  })
  expect(answerParts({ ...q, answer: '"a \\\\", D' })).toEqual({ chosen: ['D'], typed: ['a \\'], notesOnly: false })
})

test('a label that holds a quote and a comma is quoted by the engine and is still a chosen label', () => {
  const q = {
    question: 'Which?',
    header: 'Pick',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'say "hi", ok' }],
    answer: 'A, "say \\"hi\\", ok"',
  }
  expect(answerParts(q)).toEqual({ chosen: ['A', 'say "hi", ok'], typed: [], notesOnly: false })
})

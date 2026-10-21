// The mappers from engine inputs to domain events. Pure. Plan: L3 Task 8 (file named hook-events because
// tests/events.test.ts already covers the auto tracker's fact parsers).
import { expect, test } from 'claude-code/testing'
import { rowEvent, spawnEvent, toolCallEvent, turnEvent, turnStartEvent } from '../hooks/events'

const text = (t: string) => [{ type: 'text', text: t }]

test('rowEvent reads the door, origin kind and agent from the input and the text from the stored row', () => {
  const ev = rowEvent(
    { door: 'prompt', origin: { kind: 'composer' }, agentId: 'a1' },
    { message: { content: text('hello') } },
  )
  expect(ev).toEqual({
    door: 'prompt',
    origin: 'composer',
    agentId: 'a1',
    isMeta: false,
    hasMessage: true,
    text: 'hello',
  })
})

test('rowEvent takes isMeta from the stored message, and keeps the task field of a notification', () => {
  const task = { id: 't1', status: 'completed' }
  const ev = rowEvent({ door: 'prompt', origin: { kind: 'task-notification' }, task } as never, {
    message: { isMeta: true, content: text('done') },
  })
  expect(ev).toMatchObject({ isMeta: true, task, origin: 'task-notification', text: 'done' })
  expect('agentId' in ev).toBe(false)
})

test('rowEvent without a stored message has no text and hasMessage false', () => {
  const ev = rowEvent({ door: 'response', origin: { kind: 'model' } }, {})
  expect(ev).toEqual({ door: 'response', origin: 'model', isMeta: false, hasMessage: false, text: '' })
})

test('rowEvent reads tool_result content as text', () => {
  const ev = rowEvent(
    { door: 'tool-result', origin: { kind: 'tool' } },
    { message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'see https://example.com' }] } },
  )
  expect(ev.text).toBe('see https://example.com')
})

test('toolCallEvent carries the whole input, the answer, the agent, the tool use id and the cwd before the call', () => {
  const e = { tool: 'Bash', command: 'ls', tool_use_id: 'toolu_1', agentId: 'a2' }
  const ran = { result: { stdout: 'x' } }
  expect(toolCallEvent(e, ran, '/work')).toEqual({
    tool: 'Bash',
    input: e,
    result: ran,
    agentId: 'a2',
    toolUseId: 'toolu_1',
    cwdBefore: '/work',
  })
})

test('toolCallEvent leaves out what the call did not have', () => {
  const ev = toolCallEvent({ tool: 'Monitor' }, undefined, undefined)
  expect(ev).toEqual({ tool: 'Monitor', input: { tool: 'Monitor' }, result: null })
})

test('spawnEvent carries the input, the answer and the cwd read before the spawn', () => {
  const e = { description: 'd', subagentType: 'Explore' }
  expect(spawnEvent(e, { agentId: 'a1' }, '/work')).toEqual({
    input: e,
    answer: { agentId: 'a1' },
    sessionCwd: '/work',
  })
  expect(spawnEvent(e, undefined, undefined)).toEqual({ input: e, answer: null })
})

test('turnEvent carries the input', () => {
  expect(turnEvent({ reason: 'answer', agentId: 'a1' })).toEqual({ input: { reason: 'answer', agentId: 'a1' } })
})

test('turnStartEvent keeps the turn id and the text and nothing else of the input', () => {
  expect(turnStartEvent({ turnId: 't1', text: 'go', agentId: undefined } as never)).toEqual({
    turnId: 't1',
    text: 'go',
  })
})

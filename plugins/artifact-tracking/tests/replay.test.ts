// Replay: the transcript read back as one batch of rows and tool calls. Pure mapper plus a thin reader.
// Spec 5.6.1. Plan: L3 Task 7, decisions D5 and D7.
import { expect, test } from 'claude-code/testing'
import { Replay, transcriptItems } from '../core/infra/replay'

const use = (tool: string, input: Record<string, unknown>, text = '') => ({
  tool_use_id: `t-${tool}`,
  tool,
  input,
  result: { ok: true },
  text,
  isError: false,
})

test('messages map to rows and tool calls in transcript order with origin replay', () => {
  const read = use('Read', { file_path: '/work/a.md' }, 'seen https://github.com/o/r/pull/1')
  const batch = transcriptItems([
    { role: 'user', text: 'Please read a.md', toolUses: [] },
    { role: 'assistant', text: 'Reading it', toolUses: [read, use('Write', { file_path: '/work/b.md' })] },
  ])
  expect(batch.map(i => (i.kind === 'row' ? `row:${i.ev.door}` : `call:${i.ev.tool}`))).toEqual([
    'row:prompt',
    'row:response',
    'call:Read',
    'call:Write',
  ])
  expect(batch[0]).toEqual({
    kind: 'row',
    ev: { door: 'prompt', origin: 'replay', isMeta: false, hasMessage: true, text: 'Please read a.md' },
  })
  expect(batch[2]).toEqual({
    kind: 'toolCall',
    ev: { tool: 'Read', input: { file_path: '/work/a.md' }, result: read, toolUseId: 't-Read' },
  })
})

test('a user message is door prompt, an assistant message door response', () => {
  const batch = transcriptItems([
    { role: 'user', text: 'u', toolUses: [] },
    { role: 'assistant', text: 'a', toolUses: [] },
    { role: 'system', text: 'skipped', toolUses: [] },
  ])
  expect(batch.map(i => (i.kind === 'row' ? i.ev.door : '?'))).toEqual(['prompt', 'response'])
})

test('a tool call keeps the whole use as its result, so its text travels with it', () => {
  const r = use('Bash', { command: 'ls' }, 'see https://example.com/x')
  const [call] = transcriptItems([{ role: 'assistant', text: '', toolUses: [r] }]).filter(i => i.kind === 'toolCall')
  expect(call).toMatchObject({ kind: 'toolCall', ev: { result: { text: 'see https://example.com/x' } } })
})

test('a message with no text or no tool uses still maps; a malformed entry is skipped', () => {
  const batch = transcriptItems([
    { role: 'user' },
    { role: 'assistant', text: 7, toolUses: 'nope' },
    null,
    'text',
    { role: 'assistant', text: 'ok', toolUses: [null, { tool: 5 }, { tool: 'Read' }] },
  ])
  expect(batch.map(i => (i.kind === 'row' ? `row:${i.ev.text}` : `call:${i.ev.tool}`))).toEqual([
    'row:',
    'row:',
    'row:ok',
    'call:Read',
  ])
  expect(batch[3]).toMatchObject({ ev: { input: {}, result: { tool: 'Read' } } })
  expect((batch[3] as { ev: { toolUseId?: string } }).ev.toolUseId).toBeUndefined()
})

test('a non-array answer gives an empty batch', async () => {
  expect(transcriptItems(undefined)).toEqual([])
  expect(transcriptItems({ role: 'user' })).toEqual([])
  const logs: string[] = []
  expect(await new Replay({ messages: async () => 'nope', log: l => logs.push(l) }).collect()).toEqual([])
  expect(logs).toEqual([])
})

test('collect reads the transcript once and maps it', async () => {
  let reads = 0
  const replay = new Replay({
    messages: async () => {
      reads++
      return [{ role: 'user', text: 'hi', toolUses: [] }]
    },
    log: () => {},
  })
  expect(await replay.collect()).toHaveLength(1)
  expect(reads).toBe(1)
})

test('a rejected messages() logs one line and gives an empty batch', async () => {
  const logs: string[] = []
  const replay = new Replay({
    messages: async () => {
      throw new Error('no transcript')
    },
    log: l => logs.push(l),
  })
  expect(await replay.collect()).toEqual([])
  expect(logs).toEqual(['replay: reading the transcript failed: no transcript'])
})

test('a rejection that is not an Error is logged as text', async () => {
  const logs: string[] = []
  const replay = new Replay({
    messages: () => Promise.reject('plain'),
    log: l => logs.push(l),
  })
  await replay.collect()
  expect(logs).toEqual(['replay: reading the transcript failed: plain'])
})

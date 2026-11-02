// Replay: the transcript read back as one batch of rows and tool calls. Pure mapper plus a thin reader.
// Spec 5.6.1. Plan: L3 Task 7, decisions D5 and D7.
import { expect, test } from 'claude-code/testing'
import {
  AGENT_READ_CONCURRENCY,
  agentIdsOf,
  agentItems,
  MAX_AGENT_READS,
  Replay,
  transcriptItems,
} from '../core/infra/replay'
import type { ReplayItem } from '../core/interfaces/events'
import { AUTO_DEFAULTS } from '../trackers/auto/config'
import * as ev from './fixtures/events'

declare function setTimeout(fn: () => void, ms: number): unknown

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
  expect(
    batch.map(i => (i.kind === 'row' ? `row:${i.ev.door}` : i.kind === 'toolCall' ? `call:${i.ev.tool}` : '?')),
  ).toEqual(['row:prompt', 'row:response', 'call:Read', 'call:Write'])
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
  expect(
    batch.map(i => (i.kind === 'row' ? `row:${i.ev.text}` : i.kind === 'toolCall' ? `call:${i.ev.tool}` : '?')),
  ).toEqual(['row:', 'row:', 'row:ok', 'call:Read'])
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

// A regular subagent's own transcript (issue #247): its Bash uses come back as `agentCall` items.
const agentRows = () => [
  ...ev.subBash('s1', 'gh pr create --title x', `${ev.DEMO_PULL}/9`),
  ...ev.subBash('s2', 'gh pr view 9', 'title: x', true),
]
const callsIn = (batch: readonly ReplayItem[]) => batch.filter(i => i.kind === 'agentCall').length

test('agentIdsOf gives the string ids of Agent uses only, oldest first, once each', () => {
  expect(
    agentIdsOf([
      ev.agentUse('a1', 'ag-1'),
      ev.agentUse('a2'),
      ev.agentUse('a3', 'ag-2'),
      ev.agentUse('a4', 'ag-1'),
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: {}, result: { agentId: 'no' } }],
      },
    ]),
  ).toEqual(['ag-1', 'ag-2'])
  expect(agentIdsOf('nope')).toEqual([])
})

test('agentItems pairs each Bash use with its answer and keeps the error flag', () => {
  expect(agentItems(agentRows())).toEqual([
    {
      kind: 'agentCall',
      tool: 'Bash',
      input: { command: 'gh pr create --title x' },
      text: `${ev.DEMO_PULL}/9`,
      isError: false,
    },
    {
      kind: 'agentCall',
      tool: 'Bash',
      input: { command: 'gh pr view 9' },
      text: 'title: x',
      isError: true,
    },
  ])
})

test('agentItems keeps the tool of each call, whatever it is, and skips a use with no answer', () => {
  const rows = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: {}, text: 'x' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r', text: 'x' }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Bash', input: { command: 'gh pr create' } }] },
  ]
  expect(agentItems(rows)).toEqual([{ kind: 'agentCall', tool: 'Read', input: {}, text: 'x', isError: false }])
})

test('agentItems takes the text of the answer when the use has none, and an answer with no error flag is no error', () => {
  const rows = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Bash', input: { command: 'gh pr create' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u', text: `${ev.DEMO_PULL}/4` }] },
  ]
  expect(agentItems(rows)).toEqual([
    { kind: 'agentCall', tool: 'Bash', input: { command: 'gh pr create' }, text: `${ev.DEMO_PULL}/4`, isError: false },
  ])
})

test('agentIdsOf reads the id of a foreground use from its completed result and from the use itself', () => {
  expect(
    agentIdsOf([
      ev.agentUseFg('f1', 'fg-result', 'result'),
      ev.agentUseFg('f2', 'fg-use', 'use'),
      ev.agentUseFg('f3', 'fg-result', 'result'),
    ]),
  ).toEqual(['fg-result', 'fg-use'])
})

test('collect reads each subagent transcript after the main one and appends agentCall items in the order of the ids', async () => {
  const replay = new Replay({
    messages: async o => {
      if (o?.agentId === 'ag-1') await new Promise<void>(r => setTimeout(r, 0)) // the first id answers last
      return o?.agentId === undefined ? [ev.agentUse('a1', 'ag-1'), ev.agentUse('a2', 'ag-2')] : agentRows()
    },
    log: () => {},
  })
  const batch = await replay.collect()
  expect(callsIn(batch)).toBe(4)
  expect(batch.map(i => i.kind).at(-1)).toBe('agentCall')
})

test('collect reads a foreground Agent use through messages({ agentId }), whichever shape holds the id', async () => {
  const reads: string[] = []
  const replay = new Replay({
    messages: async o => {
      if (o?.agentId !== undefined) reads.push(o.agentId)
      return o?.agentId === undefined
        ? [ev.agentUseFg('f1', 'fg-result', 'result'), ev.agentUseFg('f2', 'fg-use', 'use')]
        : agentRows()
    },
    log: () => {},
  })
  expect(callsIn(await replay.collect())).toBe(4)
  expect(reads).toEqual(['fg-result', 'fg-use'])
})

test('collect reads at most four subagent transcripts at a time', async () => {
  let running = 0
  let peak = 0
  const ids = Array.from({ length: 9 }, (_, i) => ev.agentUse(`a${i}`, `ag-${i}`))
  const replay = new Replay({
    messages: async o => {
      if (o?.agentId === undefined) return ids
      running++
      peak = Math.max(peak, running)
      await new Promise<void>(r => setTimeout(r, 0))
      running--
      return []
    },
    log: () => {},
  })
  await replay.collect()
  expect(peak).toBe(AGENT_READ_CONCURRENCY)
  expect(AGENT_READ_CONCURRENCY).toBe(4)
})

test('the read cap of core is the default maxAgents of the auto tracker', () => {
  expect(MAX_AGENT_READS).toBe(AUTO_DEFAULTS.maxAgents)
})

test('an unreadable subagent logs once, is skipped, and leaves the others and the main batch intact', async () => {
  const logs: string[] = []
  const replay = new Replay({
    messages: async o => {
      if (o?.agentId === 'ag-1') throw new Error('gone')
      return o?.agentId === undefined
        ? [{ role: 'user', text: 'hi', toolUses: [] }, ev.agentUse('a1', 'ag-1'), ev.agentUse('a2', 'ag-2')]
        : agentRows()
    },
    log: l => logs.push(l),
  })
  const batch = await replay.collect()
  expect(logs).toEqual(['replay: reading the transcript of agent ag-1 failed: gone'])
  expect(batch.some(i => i.kind === 'row')).toBe(true)
  expect(callsIn(batch)).toBe(2)
})

test('collect reads the newest 200 subagents at most', async () => {
  const reads: string[] = []
  const many = Array.from({ length: 250 }, (_, i) => ev.agentUse(`a${i}`, `ag-${i}`))
  const replay = new Replay({
    messages: async o => {
      if (o?.agentId !== undefined) reads.push(o.agentId)
      return o?.agentId === undefined ? many : []
    },
    log: () => {},
  })
  await replay.collect()
  expect(reads).toHaveLength(200)
  expect(reads[0]).toBe('ag-50')
  expect(reads.at(-1)).toBe('ag-249')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandRepliesOf, FakeApi, type FakeTurn, streamOf, toolResultsOf } from '../support/fake-api.ts'
import { fakeApiEnv, PARENT_SESSION_VARS } from '../support/fake-api-env.ts'

const ASK: FakeTurn = [
  { type: 'text', text: 'I have a question.' },
  {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'AskUserQuestion',
    input: { questions: [{ question: 'Where?', header: 'Storage', multiSelect: false, options: [] }] },
  },
]
const DONE: FakeTurn = [{ type: 'text', text: 'Noted.' }]

/** The `stop_reason` of the `message_delta` event of a stream. */
const stopReasonOf = (events: { type: string; [key: string]: unknown }[]): unknown => {
  const delta = events.find(e => e.type === 'message_delta')?.delta
  return typeof delta === 'object' && delta !== null ? (delta as { stop_reason?: unknown }).stop_reason : undefined
}

/** The data of each server-sent event of a stream, in order. */
const eventsOf = (stream: string): { type: string; [key: string]: unknown }[] =>
  stream
    .split('\n\n')
    .filter(Boolean)
    .map(chunk => JSON.parse(chunk.split('\n')[1]!.replace(/^data: /, '')))

/** The text of the text deltas of a stream, joined. */
const textOf = (stream: string): string =>
  eventsOf(stream)
    .flatMap(e => (e.type === 'content_block_delta' ? [(e.delta as { text?: string }).text ?? ''] : []))
    .join('')

const post = (api: FakeApi, body: unknown, path = '/v1/messages') =>
  fetch(`${api.url}${path}`, { method: 'POST', body: JSON.stringify(body) })

test('a text turn streams as message_start, a text block in pieces, message_delta end_turn and message_stop', () => {
  const events = eventsOf(streamOf([{ type: 'text', text: 'abcdefghijklmnopqrstuvwxyz' }], 'msg_1', 'haiku'))
  assert.deepEqual(
    events.map(e => e.type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  const text = events.filter(e => e.type === 'content_block_delta').map(e => (e.delta as { text: string }).text)
  assert.equal(text.join(''), 'abcdefghijklmnopqrstuvwxyz')
  assert.equal(stopReasonOf(events), 'end_turn')
  assert.equal((events[0]?.message as { model: string } | undefined)?.model, 'haiku')
})

test('a tool_use block streams its input as partial JSON that joins to the input, and the turn stops with tool_use', () => {
  const events = eventsOf(streamOf(ASK, 'msg_2', 'haiku'))
  const start = events.find(e => e.type === 'content_block_start' && e.index === 1)
  assert.deepEqual(start?.content_block, { type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: {} })
  const json = events
    .filter(e => e.type === 'content_block_delta' && e.index === 1)
    .map(e => (e.delta as { partial_json: string }).partial_json)
    .join('')
  assert.deepEqual(JSON.parse(json), (ASK[1] as { input: unknown }).input)
  assert.equal(stopReasonOf(events), 'tool_use')
})

test('toolResultsOf reads the tool_result blocks of every message, as a string or as text parts, and no other block', () => {
  // The engine puts a system message after the tool result, so the result is not in the last message (seen live, 2.1.306).
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'earlier' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'one' },
          { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'two' }] },
          { type: 'text', text: 'not a result' },
        ],
      },
      { role: 'system', content: [{ type: 'text', text: 'last' }] },
    ],
  }
  assert.deepEqual(toolResultsOf(body), [
    { id: 'old', text: 'earlier' },
    { id: 'a', text: 'one' },
    { id: 'b', text: 'two' },
  ])
  assert.deepEqual(toolResultsOf({}), [])
  assert.deepEqual(toolResultsOf({ messages: [{ role: 'user', content: 'plain' }] }), [])
})

// Issue #246. The engine puts the reply of a slash command in the next request as a user message that holds
// `<local-command-stdout>...</local-command-stdout>`. It is not a tool result, so toolResultsOf cannot see it.
test('commandRepliesOf reads every <local-command-stdout> block of the messages, as a string or as text parts, and nothing else', () => {
  const body = {
    messages: [
      { role: 'user', content: '<command-name>/track</command-name> <command-args>qa</command-args>' },
      {
        role: 'user',
        content: '<local-command-stdout>artifact-tracking: Questions and answers Q1 (1 call)</local-command-stdout>',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'before <local-command-stdout>one\nline two</local-command-stdout> and <local-command-stdout>three</local-command-stdout>',
          },
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: '<local-command-stdout>in a tool result</local-command-stdout>',
          },
          { type: 'text', text: 'no block here' },
        ],
      },
    ],
  }
  assert.deepEqual(commandRepliesOf(body), [
    'artifact-tracking: Questions and answers Q1 (1 call)',
    'one\nline two',
    'three',
  ])
  assert.deepEqual(commandRepliesOf({}), [])
  assert.deepEqual(
    commandRepliesOf({ messages: [{ role: 'user', content: [{ type: 'text', text: '<local-command-stdout>open' }] }] }),
    [],
  )
})

test('the fake keeps the command replies that the engine sent the model, each once: a later request repeats the history', async () => {
  const api = await FakeApi.start([DONE])
  try {
    const reply = { role: 'user', content: '<local-command-stdout>artifact-tracking: the stub</local-command-stdout>' }
    await post(api, { stream: true, tools: [{ name: 'x' }], messages: [reply] })
    await post(api, {
      stream: true,
      tools: [{ name: 'x' }],
      messages: [reply, { role: 'user', content: '<local-command-stdout>a later reply</local-command-stdout>' }],
    })
    assert.deepEqual(api.commandReplies(), ['artifact-tracking: the stub', 'a later reply'])
    assert.deepEqual(
      api.requests.map(r => r.commandReplies.length),
      [1, 2],
    )
  } finally {
    await api.close()
  }
})

test('the fake plays one turn for each request with tools, in order, and the last turn repeats', async () => {
  const api = await FakeApi.start([ASK, DONE])
  try {
    const tools = [{ name: 'AskUserQuestion' }]
    const first = await (await post(api, { stream: true, model: 'haiku', tools })).text()
    assert.match(first, /AskUserQuestion/)
    const second = await (await post(api, { stream: true, model: 'haiku', tools })).text()
    assert.match(second, /Noted\./)
    const third = await (await post(api, { stream: true, model: 'haiku', tools })).text()
    assert.match(third, /Noted\./)
    assert.equal(api.turnsTaken, 3)
  } finally {
    await api.close()
  }
})

test('a request with no tools is no turn: it gets a title and the script keeps its first turn', async () => {
  const api = await FakeApi.start([ASK, DONE])
  try {
    const title = await (await post(api, { stream: true, model: 'haiku', messages: [] })).text()
    const said = eventsOf(title)
      .filter(e => e.type === 'content_block_delta')
      .map(e => (e.delta as { text: string }).text)
      .join('')
    assert.equal(said, '{"title":"Fake model"}')
    assert.equal(api.turnsTaken, 0)
    const turn = await (await post(api, { stream: true, tools: [{ name: 'x' }] })).text()
    assert.match(turn, /AskUserQuestion/)
    assert.deepEqual(
      api.requests.map(r => r.isTurn),
      [false, true],
    )
  } finally {
    await api.close()
  }
})

test('a request that is not a stream gets the text of the turn as one JSON message', async () => {
  const api = await FakeApi.start([DONE])
  try {
    const body = (await (await post(api, { model: 'haiku', tools: [{ name: 'x' }] })).json()) as {
      content: { text: string }[]
      stop_reason: string
    }
    assert.equal(body.content[0]?.text, 'Noted.')
    assert.equal(body.stop_reason, 'end_turn')
  } finally {
    await api.close()
  }
})

test('the fake keeps the tool results that the engine sent the model, each once: a later request repeats the history', async () => {
  const api = await FakeApi.start([DONE])
  try {
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'answered: State only' }] },
    ]
    await post(api, { stream: true, tools: [{ name: 'x' }], messages })
    await post(api, {
      stream: true,
      tools: [{ name: 'x' }],
      messages: [...messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'later' }] }],
    })
    assert.deepEqual(api.toolResults(), ['answered: State only', 'later'])
  } finally {
    await api.close()
  }
})

test('another path or method is a 404, and count_tokens answers a count', async () => {
  const api = await FakeApi.start([DONE])
  try {
    assert.equal((await fetch(`${api.url}/other`, { method: 'POST', body: '{}' })).status, 404)
    assert.equal((await fetch(`${api.url}/v1/messages`)).status, 404)
    const counted = (await (await post(api, {}, '/v1/messages/count_tokens')).json()) as { input_tokens: number }
    assert.equal(counted.input_tokens, 10)
  } finally {
    await api.close()
  }
})

test('a body that is no JSON is a request with no tools', async () => {
  const api = await FakeApi.start([DONE])
  try {
    const res = await fetch(`${api.url}/v1/messages`, { method: 'POST', body: 'not json' })
    assert.equal(res.status, 200)
    assert.equal(api.turnsTaken, 0)
  } finally {
    await api.close()
  }
})

test('a script that ends in a tool call is refused: its last turn would repeat the call', async () => {
  await assert.rejects(FakeApi.start([ASK]), /must end in a turn of text/)
  await assert.rejects(FakeApi.start([]), /must end in a turn of text/)
  // A function as the last step is refused too: it would repeat for every later request, and what it returns is not known.
  await assert.rejects(FakeApi.start([() => ASK]), /must end in a turn of text/)
})

test('the session of the fake talks to the fake alone: its address, a token that is no secret, a home of its own', () => {
  const env = fakeApiEnv('http://127.0.0.1:1234', '/tmp/home')
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'fake')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/home')
})

test('the variables of a parent session are removed, and the settings that switch a feature on stay', () => {
  assert.ok(PARENT_SESSION_VARS.includes('CLAUDE_CODE_SESSION_ID'))
  assert.ok(PARENT_SESSION_VARS.includes('CLAUDECODE'))
  assert.ok(PARENT_SESSION_VARS.every(name => !name.startsWith('CLAUDE_CODE_ENABLE_')))
})

// Issue #206. A task id is made by the engine, so a script cannot know it: a turn can be a function of what the engine
// told the model so far (the tool results of the history).
test('a turn that is a function gets the tool results of its request, and its answer is the turn', async () => {
  const seen: string[][] = []
  const api = await FakeApi.start([
    results => {
      seen.push(results.map(r => r.text))
      return [{ type: 'tool_use', id: 'toolu_f', name: 'TaskStop', input: { task_id: results[0]?.text ?? 'none' } }]
    },
    DONE,
  ])
  try {
    const history = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ID: b123' }] }
    const res = await post(api, { stream: true, tools: [{ name: 'x' }], messages: [history] })
    const json = eventsOf(await res.text())
      .filter(e => e.type === 'content_block_delta')
      .map(e => (e.delta as { partial_json: string }).partial_json)
      .join('')
    assert.deepEqual(JSON.parse(json), { task_id: 'ID: b123' })
    assert.deepEqual(seen, [['ID: b123']])
  } finally {
    await api.close()
  }
})

test('a turn function that throws is answered with a text turn, the error is kept, and the server stays up', async () => {
  const api = await FakeApi.start([
    () => {
      throw new Error('no task id')
    },
    DONE,
  ])
  try {
    const errorOf = (): string | undefined => api.scriptError?.message
    assert.equal(errorOf(), undefined)
    const first = await post(api, { stream: true, tools: [{ name: 'x' }], messages: [] })
    assert.equal(first.status, 200)
    assert.equal(textOf(await first.text()), 'fake script failed.')
    assert.equal(errorOf(), 'no task id')
    // The step counted as taken, and the server still answers the next request.
    const second = await post(api, { stream: true, tools: [{ name: 'x' }], messages: [] })
    assert.equal(textOf(await second.text()), 'Noted.')
    assert.equal(errorOf(), 'no task id')
  } finally {
    await api.close()
  }
})

test('a script for the subagents keeps their turns apart from the main turns, whatever the order of the requests', async () => {
  const text = (t: string): FakeTurn => [{ type: 'text', text: t }]
  const api = await FakeApi.start([text('main one'), text('main two')], [text('agent one'), text('agent two')])
  try {
    const tools = [{ name: 'Bash' }]
    const main = { stream: true, tools, system: [{ type: 'text', text: 'You are Claude Code, the CLI.' }] }
    const agent = {
      stream: true,
      tools,
      system: [{ type: 'text', text: "You are an agent for Claude Code, Anthropic's official CLI." }],
    }
    const ask = async (body: unknown) => textOf(await (await post(api, body)).text())
    assert.equal(await ask(main), 'main one')
    assert.equal(await ask(agent), 'agent one')
    assert.equal(await ask(agent), 'agent two')
    assert.equal(await ask(main), 'main two')
    assert.equal(api.turnsTaken, 2)
  } finally {
    await api.close()
  }
})

test('a script with no subagent script gives every request the next turn, as before', async () => {
  const text = (t: string): FakeTurn => [{ type: 'text', text: t }]
  const api = await FakeApi.start([text('one'), text('two')])
  try {
    const agent = { stream: true, tools: [{ name: 'Bash' }], system: 'You are an agent for Claude Code' }
    assert.equal(textOf(await (await post(api, agent)).text()), 'one')
    assert.equal(textOf(await (await post(api, agent)).text()), 'two')
  } finally {
    await api.close()
  }
})

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// A fake Anthropic Messages API for a scenario that needs a turn the real model would not give twice: Claude asks a question
// with the AskUserQuestion tool (issue #71). It plays a list of turns, one for each request that carries tools, and streams
// each as the real API does (server-sent events). The session still draws its own dialog and runs the mod: only the model is
// a script. No account and no network are used: the session talks to 127.0.0.1.
//
// A request with no tools is not a turn of the script. The engine sends one to name the session, and a fake that answered it
// from the script would lose its first turn. It gets a fixed answer. After the last turn the engine gets that turn again, so a
// script must end in a turn of text.

export type FakeBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }

/** One answer of the model: its blocks, in order. A turn that holds a `tool_use` stops with `tool_use`, else with `end_turn`. */
export type FakeTurn = readonly FakeBlock[]

/** What the fake saw of a request: whether it was a turn of the script, the tool results and the command replies it carried. */
export type FakeRequest = {
  readonly isTurn: boolean
  /** Every `tool_result` block of the request, in order: what the engine told the model about its tools so far. */
  readonly toolResults: readonly { readonly id: string; readonly text: string }[]
  /** The text of every `<local-command-stdout>` block of the request, in order: the replies of the slash commands the model reads. */
  readonly commandReplies: readonly string[]
}

/** The answer to a request with no tools: a title, in the form the engine asks for. */
const AUX_ANSWER: FakeTurn = [{ type: 'text', text: '{"title":"Fake model"}' }]

/** One server-sent event of the Messages API stream. */
const event = (name: string, data: Record<string, unknown>): string =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`

/** A text in pieces of `size` characters, as a stream delivers it. An empty text is one empty piece. */
const pieces = (text: string, size: number): string[] => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? ['']

/** The stream of one turn: the events, in order. */
export function streamOf(turn: FakeTurn, id: string, model: string): string {
  const out = [
    event('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  ]
  turn.forEach((block, index) => {
    if (block.type === 'text') {
      out.push(event('content_block_start', { index, content_block: { type: 'text', text: '' } }))
      for (const text of pieces(block.text, 15)) {
        out.push(event('content_block_delta', { index, delta: { type: 'text_delta', text } }))
      }
    } else {
      out.push(
        event('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        }),
      )
      for (const partial_json of pieces(JSON.stringify(block.input), 20)) {
        out.push(event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } }))
      }
    }
    out.push(event('content_block_stop', { index }))
  })
  const stop_reason = turn.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
  out.push(
    event('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }),
    event('message_stop', {}),
  )
  return out.join('')
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The `tool_result` blocks of a request body, in order. The result of a tool is in the message that follows its call, and
 * the engine adds a message of its own after that one: the last message is not the one to read.
 */
export function toolResultsOf(body: unknown): { id: string; text: string }[] {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : []
  return messages.flatMap(message => {
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : []
    return content.flatMap(block => {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return []
      const inner = block.content
      const parts =
        typeof inner === 'string'
          ? [inner]
          : Array.isArray(inner)
            ? inner.flatMap(part => (isRecord(part) && typeof part.text === 'string' ? [part.text] : []))
            : []
      return parts.map(text => ({ id: block.tool_use_id as string, text }))
    })
  })
}

/** The block that the engine puts a command reply in, in the next request (spike #196, `concepts/turn-strip.md`, S12). */
const COMMAND_REPLY = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g

/**
 * The replies of the slash commands that a request body carries, in order: the text inside each `<local-command-stdout>` block
 * of a message (issue #246). The block is in the text of a user message, as a string or as text parts. A `tool_result` is not
 * read: its text is no reply of a command. A block that is not closed is no reply.
 */
export function commandRepliesOf(body: unknown): string[] {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : []
  return messages.flatMap(message => {
    const content = isRecord(message) ? message.content : undefined
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content.flatMap(part =>
              isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
            )
          : []
    return texts.flatMap(text => [...text.matchAll(COMMAND_REPLY)].map(m => m[1] ?? ''))
  })
}

export class FakeApi {
  /** Every request to the messages endpoint, in order. */
  readonly requests: FakeRequest[] = []
  readonly url: string
  private readonly server: Server
  private readonly turns: readonly FakeTurn[]
  private taken = 0

  private constructor(server: Server, turns: readonly FakeTurn[], url: string) {
    this.server = server
    this.turns = turns
    this.url = url
  }

  /** Starts a fake on a free port of 127.0.0.1. `turns` is the script: at least one, and the last is a turn of text. */
  static async start(turns: readonly FakeTurn[]): Promise<FakeApi> {
    const last = turns.at(-1)
    if (last === undefined || last.some(block => block.type === 'tool_use'))
      throw new Error('fake api: the script must end in a turn of text, or the last turn would repeat its tool call')
    const server = createServer()
    const api: { current?: FakeApi } = {}
    server.on('request', (req, res) => void api.current?.answer(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    api.current = new FakeApi(server, turns, `http://127.0.0.1:${port}`)
    return api.current
  }

  /** How many turns of the script the engine took. */
  get turnsTaken(): number {
    return this.taken
  }

  /** The text of every tool result the engine sent the model, in order. A request repeats the history, so each result counts once. */
  toolResults(): string[] {
    const seen = new Set<string>()
    return this.requests
      .flatMap(r => r.toolResults)
      .filter(r => {
        const key = `${r.id}\u0000${r.text}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map(r => r.text)
  }

  /**
   * The text of every command reply the engine sent the model, in order, each once: a request repeats the history. A second reply
   * with the same words counts once, which is enough to ask whether the model read some words.
   */
  commandReplies(): string[] {
    return [...new Set(this.requests.flatMap(r => r.commandReplies))]
  }

  close(): Promise<void> {
    this.server.closeAllConnections()
    return new Promise(resolve => this.server.close(() => resolve()))
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method !== 'POST' || !url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        return
      }
      if (url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}')
        return
      }
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools.length : 0
      const model = isRecord(body) && typeof body.model === 'string' ? body.model : 'fake'
      const stream = isRecord(body) && body.stream === true
      const isTurn = tools > 0
      this.requests.push({ isTurn, toolResults: toolResultsOf(body), commandReplies: commandRepliesOf(body) })
      const turn = isTurn ? (this.turns[Math.min(this.taken, this.turns.length - 1)] as FakeTurn) : AUX_ANSWER
      if (isTurn) this.taken += 1
      if (!stream) {
        const text = turn.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: `msg_fake_${this.requests.length}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(streamOf(turn, `msg_fake_${this.requests.length}`, model))
    })
  }
}

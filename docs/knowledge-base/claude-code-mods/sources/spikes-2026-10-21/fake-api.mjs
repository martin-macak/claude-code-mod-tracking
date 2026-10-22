// Fake Anthropic Messages API for the issue #71 spike.
// env: PORT, SEQ (JSON file: a list of turns, each a list of text / tool_use blocks), LOG (ndjson of every request's last message).
// A streamed request takes the next turn of SEQ; the last turn repeats. A non-streamed request (titles, probes) gets "ok".
import fs from 'node:fs'
import http from 'node:http'

const port = Number(process.env.PORT || 8801)
const seq = JSON.parse(fs.readFileSync(process.env.SEQ, 'utf8'))
const log = process.env.LOG
let n = 0

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages') || req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"input_tokens":10}')
      }
      let j = {}
      try {
        j = JSON.parse(body)
      } catch {}
      if (log) {
        const last = (j.messages || []).at(-1)
        const sys = JSON.stringify(j.system || '')
        fs.appendFileSync(
          log,
          JSON.stringify({ n: n + 1, stream: !!j.stream, model: j.model, tools: (j.tools || []).map(t => t.name), planPath: /[^"\s]*plans\/[^"\s]*\.md/.exec(sys)?.[0], last }) + '\n',
        )
      }
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: j.model || 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        )
      }
      // A request with no tools is an aux call (the session title): it does not take a turn of SEQ.
      const aux = !j.tools || j.tools.length === 0
      if (!aux) n += 1
      // {{PLAN_PATH}} in a turn becomes the plan file path that plan mode names in the request.
      const plan = /(\/[A-Za-z0-9_.\/-]+\/plans\/[A-Za-z0-9_.-]+\.md)/.exec(body)?.[1] ?? '/no/plan/path.md'
      const picked = aux ? [{ type: 'text', text: '{"title":"Spike"}' }] : seq[Math.min(n - 1, seq.length - 1)]
      const turn = JSON.parse(JSON.stringify(picked).replaceAll('{{PLAN_PATH}}', plan))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (t, d) => res.write('event: ' + t + '\ndata: ' + JSON.stringify({ type: t, ...d }) + '\n\n')
      ev('message_start', { message: { id: 'msg_fake' + n, type: 'message', role: 'assistant', model: j.model || 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      turn.forEach((b, i) => {
        if (b.type === 'text') {
          ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
          for (const c of b.text.match(/[\s\S]{1,15}/g) || ['']) ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: c } })
        } else {
          ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
          const js = JSON.stringify(b.input)
          for (const c of js.match(/[\s\S]{1,20}/g) || ['']) ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: c } })
        }
        ev('content_block_stop', { index: i })
      })
      ev('message_delta', { delta: { stop_reason: turn.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
      ev('message_stop', {})
      res.end()
    })
  })
  .listen(port, '127.0.0.1', () => console.log('listening', port))

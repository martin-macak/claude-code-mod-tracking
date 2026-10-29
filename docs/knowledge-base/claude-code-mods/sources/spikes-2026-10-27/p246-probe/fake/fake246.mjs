// Fake Messages API for the issue 246 probe. Every turn answers one text. It logs, per request, which probe markers the body holds.
import fs from 'node:fs'
import http from 'node:http'
const port = Number(process.env.PORT || 8846)
const OUT = process.env.OUT
let n = 0
const MARK = /(STUB246|QA246|SECRET246|Questions and answers [A-Z-]+)/g
http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', d => (raw += d))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"input_tokens":10}')
      }
      if (req.method !== 'POST' || !url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      let j = {}
      try { j = JSON.parse(raw) } catch {}
      n += 1
      const isTurn = Array.isArray(j.tools) && j.tools.length > 0
      const s = JSON.stringify(j.messages ?? [])
      const markers = [...new Set([...s.matchAll(MARK)].map(x => x[0]))]
      const lcs = [...s.matchAll(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g)].map(x => x[1].slice(0, 160))
      fs.appendFileSync(`${OUT}/requests.jsonl`, JSON.stringify({ req: n, isTurn, messages: (j.messages ?? []).length, markers, lcs }) + '\n')
      const text = isTurn ? `ok reply ${n}` : '{"title":"Fake model"}'
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: `m${n}`, type: 'message', role: 'assistant', model: j.model || 'fake', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`)
      ev('message_start', { message: { id: `msg${n}`, type: 'message', role: 'assistant', model: j.model || 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const c of text.match(/[\s\S]{1,15}/g) || ['']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
      ev('message_stop', {})
      res.end()
    })
  })
  .listen(port, '127.0.0.1', () => console.log('listening', port))

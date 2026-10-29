// Fake Messages API for the issue 196 probe. Every turn answers one text. It logs, per request, which probe markers the
// body holds and where (message index, role, a cut around the marker). Full bodies stay in OUT/req-*.json (scratch only:
// they hold the system prompt).
import fs from 'node:fs'
import http from 'node:http'

const port = Number(process.env.PORT || 8796)
const OUT = process.env.OUT
let n = 0
let turns = 0
const MARK = /(STUB196[A-Z]?|QA196[A-Z]?(?:-FULL)?|CTRL196|SECRET196|QREAL196|Where should the probe records live\?)/g
// Optional script: SEQ names a JSON file of turns ([[block, ...], ...]) played in order for the turn requests.
const SEQ = process.env.SEQ ? JSON.parse(fs.readFileSync(process.env.SEQ, 'utf8')) : null

function scan(body) {
  const hits = []
  const msgs = Array.isArray(body.messages) ? body.messages : []
  msgs.forEach((m, i) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    for (const x of s.matchAll(MARK)) {
      const at = x.index ?? 0
      hits.push({ msg: i, role: m.role, marker: x[0], around: s.slice(Math.max(0, at - 60), at + 60) })
    }
  })
  const sys = JSON.stringify(body.system ?? '')
  for (const x of sys.matchAll(MARK)) hits.push({ msg: 'system', marker: x[0] })
  return { messages: msgs.length, hits }
}

function lcs(body) {
  // every <local-command-stdout> block of the request, cut
  const s = JSON.stringify(body.messages ?? [])
  return [...s.matchAll(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g)].map(x => x[1].slice(0, 120))
}

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
      try {
        j = JSON.parse(raw)
      } catch {}
      n += 1
      const isTurn = Array.isArray(j.tools) && j.tools.length > 0
      if (isTurn) turns += 1
      const { messages, hits } = scan(j)
      const line = { req: n, isTurn, turn: isTurn ? turns : null, stream: j.stream === true, messages, markers: [...new Set(hits.map(h => h.marker))], hits, localCommandStdout: lcs(j) }
      fs.appendFileSync(`${OUT}/requests.jsonl`, JSON.stringify(line) + '\n')
      fs.writeFileSync(`${OUT}/req-${String(n).padStart(3, '0')}.json`, raw)
      const scripted = isTurn && SEQ && SEQ[turns - 1] ? SEQ[turns - 1] : null
      const text = isTurn ? `ok reply ${turns}` : '{"title":"Fake model"}'
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: `m${n}`, type: 'message', role: 'assistant', model: j.model || 'fake', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`)
      if (scripted) {
        ev('message_start', { message: { id: `msg${n}`, type: 'message', role: 'assistant', model: j.model || 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
        scripted.forEach((b, i) => {
          if (b.type === 'text') {
            ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
            for (const c of b.text.match(/[\s\S]{1,15}/g) || ['']) ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: c } })
          } else {
            ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
            for (const c of JSON.stringify(b.input).match(/[\s\S]{1,20}/g) || ['']) ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: c } })
          }
          ev('content_block_stop', { index: i })
        })
        ev('message_delta', { delta: { stop_reason: scripted.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
        ev('message_stop', {})
        return res.end()
      }
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

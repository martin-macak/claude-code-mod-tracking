// Fake Anthropic Messages API for live checks of Claude Code against a local gateway.
// env: PORT (8799), REPLY_FILE (text for every request), REPLY_SEQ (JSON: list of turns, each a list of text/tool_use blocks).
// usage: ANTHROPIC_BASE_URL=http://127.0.0.1:8799 ANTHROPIC_AUTH_TOKEN=fake claude ...
// Fake Anthropic Messages API. Replies with the text in REPLY_FILE (re-read per request), as one streamed text block split in deltas.
import http from 'node:http'
import fs from 'node:fs'
const port = Number(process.env.PORT || 8799)
const replyFile = process.env.REPLY_FILE
const log = process.env.REQ_LOG
http.createServer((req, res) => {
  let body = ''
  req.on('data', d => body += d)
  req.on('end', () => {
    if (log) fs.appendFileSync(log, req.method + ' ' + req.url + '\n')
    if (!req.url.startsWith('/v1/messages') || req.method !== 'POST') { res.writeHead(404, {'content-type':'application/json'}); return res.end('{}') }
    if (req.url.includes('count_tokens')) { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"input_tokens":10}') }
    let j = {}; try { j = JSON.parse(body) } catch {}
    const seq = process.env.REPLY_SEQ ? JSON.parse(fs.readFileSync(process.env.REPLY_SEQ, 'utf8')) : null
    if (seq && !j.stream) { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ id:'msg_fake', type:'message', role:'assistant', model:j.model||'fake', content:[{type:'text',text:'ok'}], stop_reason:'end_turn', stop_sequence:null, usage:{input_tokens:1,output_tokens:1} })) }
    if (seq) {
      const n = seq.counter = (globalThis.__n = (globalThis.__n || 0) + 1)
      const turn = seq[Math.min(n - 1, seq.length - 1)]
      res.writeHead(200, {'content-type':'text/event-stream'})
      const ev = (t, d) => res.write('event: ' + t + '\ndata: ' + JSON.stringify({ type: t, ...d }) + '\n\n')
      ev('message_start', { message: { id:'msg_fake'+n, type:'message', role:'assistant', model: j.model||'fake', content:[], stop_reason:null, stop_sequence:null, usage:{input_tokens:10,output_tokens:1} } })
      turn.forEach((b, i) => {
        if (b.type === 'text') {
          ev('content_block_start', { index: i, content_block: { type:'text', text:'' } })
          for (const c of (b.text.match(/[\s\S]{1,15}/g) || [''])) ev('content_block_delta', { index: i, delta: { type:'text_delta', text: c } })
        } else {
          ev('content_block_start', { index: i, content_block: { type:'tool_use', id: b.id, name: b.name, input: {} } })
          const js = JSON.stringify(b.input)
          for (const c of (js.match(/[\s\S]{1,20}/g) || [''])) ev('content_block_delta', { index: i, delta: { type:'input_json_delta', partial_json: c } })
        }
        ev('content_block_stop', { index: i })
      })
      ev('message_delta', { delta: { stop_reason: turn.some(b=>b.type==='tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
      ev('message_stop', {})
      return res.end()
    }
    const text = fs.readFileSync(replyFile, 'utf8')
    const msg = { id: 'msg_fake', type: 'message', role: 'assistant', model: j.model || 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
    if (!j.stream) {
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn' }))
    }
    res.writeHead(200, {'content-type':'text/event-stream'})
    const ev = (t, d) => res.write('event: ' + t + '\ndata: ' + JSON.stringify({ type: t, ...d }) + '\n\n')
    ev('message_start', { message: msg })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    const chunks = text.match(/[\s\S]{1,20}/g) || ['']
    for (const c of chunks) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
    ev('message_stop', {})
    res.end()
  })
}).listen(port, '127.0.0.1', () => console.log('listening', port))

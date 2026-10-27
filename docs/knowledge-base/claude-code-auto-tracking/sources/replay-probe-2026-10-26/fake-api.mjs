// role-routed fake Messages API. SEQ file: { "<role>": [turns...] }. role = "sub" when first user message holds MARK, else "main".
import http from 'node:http'; import fs from 'node:fs'
const port = Number(process.env.PORT || 8799)
const counters = {}
http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d)
  req.on('end', () => {
    if (req.url.includes('count_tokens')) { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"input_tokens":10}') }
    let j = {}; try { j = JSON.parse(body) } catch {}
    const seqAll = JSON.parse(fs.readFileSync(process.env.SEQ, 'utf8'))
    const first = JSON.stringify((j.messages || [])[0] || '')
    const role = first.includes('SUBMARK') ? 'sub' : 'main'
    const marked = (!process.env.MARKER || JSON.stringify(j.messages || []).includes(process.env.MARKER)) && (!process.env.MAINONLY || (Array.isArray(j.tools) && j.tools.length > 0))
    console.log('req', JSON.stringify({ stream: !!j.stream, tools: Array.isArray(j.tools) ? j.tools.length : 0, msgs: (j.messages || []).length, marked }))
    const seq = seqAll[role] || []
    if (!j.stream) { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ id:'m', type:'message', role:'assistant', model:j.model||'fake', content:[{type:'text',text:'ok'}], stop_reason:'end_turn', stop_sequence:null, usage:{input_tokens:1,output_tokens:1} })) }
    const n = marked ? (counters[role] = (counters[role] || 0) + 1) : 0
    const turn = marked ? (seq[Math.min(n - 1, seq.length - 1)] || [{type:'text',text:'end'}]) : [{type:'text',text:'ok'}]
    res.writeHead(200, {'content-type':'text/event-stream'})
    const ev = (t, d) => res.write('event: ' + t + '\ndata: ' + JSON.stringify({ type: t, ...d }) + '\n\n')
    ev('message_start', { message: { id:'msg'+role+n, type:'message', role:'assistant', model: j.model||'fake', content:[], stop_reason:null, stop_sequence:null, usage:{input_tokens:10,output_tokens:1} } })
    turn.forEach((b, i) => {
      if (b.type === 'text') { ev('content_block_start', { index: i, content_block: { type:'text', text:'' } }); for (const c of (b.text.match(/[\s\S]{1,15}/g) || [''])) ev('content_block_delta', { index: i, delta: { type:'text_delta', text: c } }) }
      else { ev('content_block_start', { index: i, content_block: { type:'tool_use', id: b.id, name: b.name, input: {} } }); const js = JSON.stringify(b.input); for (const c of (js.match(/[\s\S]{1,20}/g) || [''])) ev('content_block_delta', { index: i, delta: { type:'input_json_delta', partial_json: c } }) }
      ev('content_block_stop', { index: i })
    })
    ev('message_delta', { delta: { stop_reason: turn.some(b=>b.type==='tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
    ev('message_stop', {}); res.end()
  })
}).listen(port, '127.0.0.1', () => console.log('listening', port))

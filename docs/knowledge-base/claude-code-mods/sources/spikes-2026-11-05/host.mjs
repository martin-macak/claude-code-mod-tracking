// A permission-prompt host for `claude -p --permission-prompt-tool stdio` (issue #312).
// It answers the can_use_tool request of AskUserQuestion with an allow whose updatedInput carries
// answers, annotations, response and followUp (VARIANT), logs every line, then sends `/track qa` as a second turn.
// Usage: VARIANT=<a|b|c> OUT=<dir> PROMPT=<text> node host.mjs <claude args...>
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'

const out = process.env.OUT ?? 'out'
mkdirSync(out, { recursive: true })
const variant = process.env.VARIANT ?? 'a'
const log = (file, obj) => appendFileSync(`${out}/${file}`, `${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`)

// A session started from inside another one must not join the parent (the list of e2e/support/fake-api-env.ts).
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
]
const env = { ...process.env }
for (const name of PARENT_SESSION_VARS) delete env[name]
if (process.env.HOST_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = process.env.HOST_ENTRYPOINT
log('env.txt', `CLAUDE_CODE_ENTRYPOINT=${env.CLAUDE_CODE_ENTRYPOINT ?? ''} CLAUDE_CODE_QUESTION_EXTENDED=${env.CLAUDE_CODE_QUESTION_EXTENDED ?? ''}`)
const child = spawn('claude', process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'], env })
child.stderr.on('data', d => log('stderr.txt', d.toString()))
const send = obj => {
  log('sent.jsonl', obj)
  child.stdin.write(`${JSON.stringify(obj)}\n`)
}
const user = text => send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })

function answerFor(input) {
  const qs = Array.isArray(input.questions) ? input.questions : []
  const extended = qs.length > 0 && qs.every(q => typeof q.kind === 'string')
  const label = q => q.options?.[0]?.label ?? 'typed by host'
  if (variant === 'a') {
    // answers, a response, and followUp where every question has a string kind
    const answers = Object.fromEntries(qs.map(q => [q.question, q.multiSelect ? [label(q), 'host typed piece'] : label(q)]))
    return { ...input, answers, response: 'Host response: please also consider caching.', ...(extended ? { followUp: true } : {}) }
  }
  if (variant === 'b') {
    // "Chat about this" as a host may send it: no answers, unanswered: replied_in_chat, a response
    const annotations = Object.fromEntries(qs.map(q => [q.question, { unanswered: 'replied_in_chat' }]))
    return { ...input, annotations, response: 'Let us talk about this first.', ...(extended ? { followUp: true } : {}) }
  }
  if (variant === 'c') {
    // followUp on questions without kind: the engine should refuse it (rule follow_up)
    const answers = Object.fromEntries(qs.map(q => [q.question, label(q)]))
    return { ...input, answers, followUp: true }
  }
  if (variant === 'd') {
    // afkTimeoutMs is the engine's own field: the engine should refuse it (rule host_field)
    const answers = Object.fromEntries(qs.map(q => [q.question, label(q)]))
    return { ...input, answers, afkTimeoutMs: 5000 }
  }
  return input
}

let turns = 0
const rl = createInterface({ input: child.stdout })
rl.on('line', line => {
  log('stdout.jsonl', line)
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.type === 'control_request') {
    const r = m.request
    log('control.jsonl', m)
    if (r.subtype === 'can_use_tool') {
      const updatedInput = r.tool_name === 'AskUserQuestion' ? answerFor(r.input) : r.input
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput } },
      })
    }
    return
  }
  if (m.type === 'result') {
    turns += 1
    if (turns === 1 && process.env.NO_QA !== '1') user('/track qa')
    else child.stdin.end()
  }
})
child.on('exit', code => {
  log('exit.txt', String(code))
  process.exit(0)
})
send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } })
user(process.env.PROMPT ?? 'Ask me one question with the AskUserQuestion tool, then stop.')

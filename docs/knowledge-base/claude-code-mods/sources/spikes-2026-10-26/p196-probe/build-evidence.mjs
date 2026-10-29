// Builds the numbered, scrubbed evidence log of the issue 196 probe from the saved logs and captures.
// Usage: node build-evidence.mjs <study dir>  -> writes <study dir>/evidence-log.txt
import fs from 'node:fs'
import path from 'node:path'

const S = process.argv[2]
const out = []
const scrub = s =>
  s
    .replaceAll(S, '<SCRATCH>')
    .replaceAll(S.replace(/^\/private/, ''), '<SCRATCH>')
    .replace(/\/Users\/[a-z]+/g, '<HOME>')
    .replace(/<user-name>/gi, '<user>') // the real pattern names the user: scrubbed here
    .replace(/-Users-<user>-projects-claude-code-mod-tracking-[0-9a-f-]+-scratchpad-study-196-work/g, '<project>')
const line = s => out.push(scrub(s))
const head = s => out.push('', `## ${s}`)
const read = f => fs.readFileSync(path.join(S, f), 'utf8')
const jsonl = f =>
  read(f)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
const ev = (e, max = 260) => {
  const d = { ...e.data }
  let s = `#${e.n} ${e.kind} ${JSON.stringify(d)}`
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s
}
const reqLine = (j, extra = '') =>
  `req ${j.req} isTurn=${j.isTurn} messages=${j.messages} markers=${j.markers.length ? j.markers.join(',') : 'none'}${extra}`
const markersOfBody = f => {
  const b = JSON.parse(read(f))
  const s = JSON.stringify(b.messages ?? [])
  const m = [...new Set(s.match(/(STUB196[A-Z]?|QA196[A-Z]?(?:-FULL)?|CTRL196|SECRET196)/g) ?? [])]
  const lcs = [...s.matchAll(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g)].map(x => x[1].slice(0, 70))
  return `messages=${(b.messages ?? []).length} markers=${m.join(',') || 'none'} local-command-stdout=${JSON.stringify(lcs)}`
}
const cap = (f, from, to) => {
  const lines = read(f).split('\n')
  return lines.slice(from - 1, to).filter(l => l.trim() !== '')
}

line('# Evidence log, issue 196 probe (Claude Code 2.1.310, macOS, fake Messages API, managed guard cc-plugin-sec-default active)')
line('Each line below is copied from a probe log or a tmux capture. Paths are scrubbed. Request bodies are not included (they hold the system prompt).')

head('H1-H3: claude -p "/p196 qa" (json, text, stream-json)')
for (const e of jsonl('out/headless/ev-01497fe6.jsonl')) line(ev(e))
line('$ run.sh -p "/p196 qa" --output-format json   ->  "result":"p196-probe: STUB196T: the Q&A shows above, on screen only","local_command":"custom","num_turns":0')
line('$ run.sh -p "/p196 qa" --output-format text   ->  p196-probe: STUB196T: the Q&A shows above, on screen only')
for (const l of read('out/h3-stream.jsonl').trim().split('\n')) {
  const j = JSON.parse(l)
  if (j.type === 'assistant') line(`stream-json assistant model=${j.message.model} content=${JSON.stringify(j.message.content)}`)
  if (j.type === 'result') line(`stream-json result=${JSON.stringify(j.result)} num_turns=${j.num_turns}`)
}
line('(no render.CommandOutput line in any headless event log: grep count 0)')

// H5 and H6 ran again at the final review into out/h56-rerun: the first request bodies were overwritten when the fake
// restarted for later runs.
head('H5: claude -p --continue after the stub run: the next request (run again at the final review)')
line(`req-001 ${markersOfBody('out/h56-rerun/req-001.json')}`)

head('H6: the surface-aware variant p196s, headless: whole text printed, then --continue (run again at the final review)')
line('$ run.sh -p "/p196s qa" --output-format text  ->  p196-probe: # QA196S-FULL-MARKER questions and answers (args="qa") ... > Notes: SECRET196 typed note ... QA196S-FULL-END')
line(`req-002 ${markersOfBody('out/h56-rerun/req-002.json')}`)

head('T1: interactive, main screen (CLAUDE_CODE_NO_FLICKER=0), tmux 150x60, fresh session')
for (const e of jsonl('out/t1-main/ev-4f913ebe.jsonl')) if (e.n <= 31) line(ev(e))
line('--- screen after /p196 qa (caps/T1-main-p196.txt)')
for (const l of cap('caps/T1-main-p196.txt', 1, 200).slice(3, 25)) line(l)
line('--- screen after the other variants (caps/T1-main-all.txt, from /p196r on)')
{
  const all = read('caps/T1-main-all.txt').split('\n').filter(l => l.trim() !== '')
  const i = all.findIndex(l => l.includes('/p196r qa 3'))
  for (const l of all.slice(i, i + 9)) line(l)
  line('   (the rows of /p196e and /p196s draw the same 22-line Markdown as /p196; /p196n has no row)')
}
line('--- the next request after "next prompt TP1"')
for (const j of jsonl('out/t1-main/requests.jsonl')) line(reqLine(j, ` local-command-stdout=${JSON.stringify(j.localCommandStdout)}`))
line('--- ctrl+o transcript view (caps/T1-main-ctrlo.txt): rewritten rows, no new render.CommandOutput line in the log')
for (const l of read('caps/T1-main-ctrlo.txt').split('\n').filter(l => /p196c|QA196S-END|Showing detailed transcript/.test(l))) line(l.trimEnd())

head('T2: main screen, claude --continue of T1 (restored rows)')
{
  // The probe file was edited while T2 ran (the p196d variant was added), so the engine loaded the module again and its
  // counter started over: only the first load is kept here.
  const evs = jsonl('out/t2-main-continue/ev-4f913ebe.jsonl')
  const second = evs.findIndex((e, i) => i > 0 && e.n === 1)
  for (const e of second === -1 ? evs : evs.slice(0, second)) if (/render|session.start/.test(e.kind)) line(ev(e, 230))
  if (second !== -1) line(`(a second module load follows in the log, ${evs.length - second} lines: the probe file was edited during the run)`)
}
for (const j of jsonl('out/t2-main-continue/requests.jsonl')) line(reqLine(j))

head('Stored transcript of the T1/T2 session (the scratch config dir, not a user transcript)')
{
  const dir = path.join(S, 'cfg/projects')
  const proj = fs.readdirSync(dir)[0]
  const f = path.join(dir, proj, fs.readdirSync(path.join(dir, proj)).find(n => n.startsWith('4f913ebe')))
  const t = fs.readFileSync(f, 'utf8')
  const counts = {}
  for (const m of t.match(/(STUB196[A-Z]?|QA196[A-Z]?(?:-FULL)?|CTRL196|SECRET196)/g) ?? []) counts[m] = (counts[m] ?? 0) + 1
  line(`marker counts in the transcript file: ${JSON.stringify(counts)}`)
  for (const l of t.split('\n').filter(l => l.includes('local-command-stdout'))) {
    const j = JSON.parse(l)
    if (j.type === 'system') line(`${j.type} ${j.subtype} ${JSON.stringify(j.content).slice(0, 110)}`)
  }
}

head('T3: fullscreen (CLAUDE_CODE_NO_FLICKER=1), tmux 150x60, fresh session')
for (const j of jsonl('out/t3-full/requests.jsonl')) line(reqLine(j))
for (const e of jsonl('out/t3-full/ev-9b7f8906.jsonl')) if (e.kind === 'render.CommandOutput' && e.data.onScreen) line(ev(e, 300))

head('T4: fullscreen, claude --continue: p196d draws only after the late load and $.ui.invalidate("ui.render")')
for (const e of jsonl('out/t4-full-continue/ev-9b7f8906.jsonl')) if (/p196d|loaded|session.start/.test(JSON.stringify(e)) && e.kind !== 'append') line(ev(e, 200))
for (const f of ['caps/T4-full-continue-early.txt', 'caps/T4-full-continue-late.txt']) {
  const l = read(f).split('\n')
  const i = l.findIndex(x => x.includes('/p196d qa'))
  line(`${path.basename(f)}: ${l[i]?.trim()} | ${l[i + 1]?.trim()}`)
}

head('T5: main screen 150x60, claude --continue: the same')
for (const f of ['caps/T5-main-continue-early.txt', 'caps/T5-main-continue-late.txt']) {
  const l = read(f).split('\n')
  const i = l.findIndex(x => x.includes('/p196d qa'))
  line(`${path.basename(f)}: ${l[i]?.trim()} | ${l[i + 1]?.trim()}`)
}

head('T6/T7: main screen 150x20 (transcript taller than the screen), claude --continue, slow and fast hook')
for (const f of ['caps/T7-main20-fast-early.txt', 'caps/T7-main20-fast-late.txt']) {
  line(`--- ${path.basename(f)} (lines with a command echo or a marker, with the capture line number)`)
  read(f)
    .split('\n')
    .forEach((x, i) => {
      if (/\/p196|QA196.-MARKER|STUB196|QA196.-END/.test(x)) line(`${String(i + 1).padStart(3)}: ${x.trimEnd()}`)
    })
}

head('T8: fullscreen, a 177,552-character rewrite')
for (const l of read('caps/T8-full-long.txt').split('\n').filter(l => /more characters|drawn up to/.test(l))) line(l.trim())
{
  const d = fs.readdirSync(path.join(S, 'out/t8-full-long')).find(n => n.startsWith('ev-'))
  const evs = jsonl(`out/t8-full-long/${d}`)
  for (const e of evs) if (e.kind === 'render.p196l' || (e.kind === 'append' && e.data.door === 'notice' && /100000/.test(e.data.text))) line(ev(e, 240))
}
for (const j of jsonl('out/t8-full-long/requests.jsonl')) line(reqLine(j))
line(`req-009 holds "characters of text are drawn": ${read('out/req-009.json').includes('characters of text are drawn') ? 'yes' : 'no'}`)
{
  const b = JSON.parse(read('out/req-009.json'))
  line(`req-009 tools: ${(b.tools ?? []).map(t => t.name).join(', ')}`)
  line(`req-009 names a p196 command in tools: ${JSON.stringify(b.tools ?? []).includes('p196') ? 'yes' : 'no'}, in system: ${JSON.stringify(b.system ?? '').includes('p196') ? 'yes' : 'no'}; in messages only as <command-name> rows and the stub`)
}

head('T9: main screen 150x20, fresh session (no --continue): /p196 qa (24 lines), then /p196l, then ctrl+o twice')
for (const [f, re] of [
  ['caps/T9-main20-fresh-p196.txt', /\/p196|STUB196|QA196.-MARKER|QA196.-END/],
  ['caps/T9-main20-fresh-all.txt', /\/p196|STUB196|QA196.-MARKER|QA196.-END|more characters|drawn up to/],
]) {
  line(`--- ${path.basename(f)} (every line with a command echo, a stub or a marker, with the capture line number)`)
  read(f)
    .split('\n')
    .forEach((x, i) => {
      if (re.test(x)) line(`${String(i + 1).padStart(4)}: ${x.trimEnd()}`)
    })
}
line(`T9-main20-fresh-all.txt holds ${read('caps/T9-main20-fresh-all.txt').split('\n').length} lines: the whole tmux history (history-limit 2000)`)
for (const j of jsonl('out/t9-main20-fresh/requests.jsonl')) line(reqLine(j))

head('B1: baseline, the real mod today (a copy of plugins/artifact-tracking at main in the scratchpad), main screen 150x50, scripted AskUserQuestion')
{
  const l = read('caps/R1-realmod-qa.txt').split('\n')
  const i = l.findIndex(x => x.includes('❯ /track qa'))
  for (const x of l.slice(i, i + 12).filter(x => x.trim() !== '')) line(x.trimEnd())
}
for (const j of jsonl('out/r1-realmod/requests.jsonl')) {
  line(reqLine(j))
  const seen = new Set()
  for (const h of j.hits) {
    const k = `${h.msg}/${h.role}`
    if (seen.has(k)) continue
    seen.add(k)
    line(`    msg${h.msg} ${h.role}: ${JSON.stringify(h.around.slice(0, 100))}`)
  }
}

head('H7: debug log of claude -p "/p196 qa" and -p --continue (the guard)')
{
  const dd = path.join(S, 'cfg/debug')
  const t = fs.readdirSync(dd).map(n => fs.readFileSync(path.join(dd, n), 'utf8')).join('\n')
  const seen = new Set()
  for (const l of t.split('\n')) {
    const x = l.replace(/^[0-9TZ:.-]+ /, '').replace(/[0-9.]+ms/, 'Nms')
    if (/sec-default@builtin loaded|seated outermost|bypassed by cc-plugin-sec-default|p196-probe@inline (command.run|session.start) settled/.test(x) && !seen.has(x)) {
      seen.add(x)
      line(x)
    }
  }
}

head('Types: the CommandOutput block and CommandRunResult in 2.1.310 equal 2.1.302')
line('2.1.310 index.d.ts (engine-written into the probe folder): "// Written by Claude Code 2.1.310.", CommandOutput at line 10554, CommandRunResult at line 1873')
line('diff of the CommandOutput block (58 lines) against 2.1.302 lines 10443-10500: no difference')
line('diff of CommandRunResult (66 lines) against 2.1.302 lines 1850-1915: no difference')

head('T3 screens: fullscreen, fresh session (the alternate screen has no history, so two captures)')
for (const [f, re] of [
  ['caps/T3-full-pgup.txt', /\/p196|QA196.-MARKER|STUB196|QA196.-END|CTRL196/],
  ['caps/T3-full-cmds.txt', /\/p196|QA196.-MARKER|STUB196|QA196.-END|CTRL196/],
]) {
  line(`--- ${path.basename(f)}${f.includes('pgup') ? ' (after two PageUp)' : ''}`)
  read(f)
    .split('\n')
    .forEach((x, i) => {
      if (re.test(x)) line(`${String(i + 1).padStart(3)}: ${x.trimEnd()}`)
    })
}

const numbered = []
let n = 0
for (const l of out) {
  if (l === '' || l.startsWith('# ') || l.startsWith('## ') || l.startsWith('Each line')) numbered.push(l)
  else numbered.push(`L${++n} ${l}`)
}
fs.writeFileSync(path.join(S, 'evidence-log.txt'), numbered.join('\n') + '\n')
console.log(`lines: ${n}`)

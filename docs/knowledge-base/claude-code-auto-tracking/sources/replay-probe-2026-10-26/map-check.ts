// Feeds the observed cold-resume transcript (TUI run) through the repo's own replay code: transcriptItems -> fromBash -> recordPr.
import { readFileSync } from 'node:fs'
import { transcriptItems } from '<repo>/plugins/artifact-tracking/core/infra/replay.ts'
import { fromBash } from '<repo>/plugins/artifact-tracking/trackers/auto/events.ts'
import { emptyAuto, recordPr } from '<repo>/plugins/artifact-tracking/trackers/auto/ledger.ts'

const rows = readFileSync(process.argv[2]!, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const messages = rows.filter(o => o.kind === 'messages@session.start').at(-1).data
const batch = transcriptItems(messages)
let s = emptyAuto()
for (const item of batch) {
  if (item.kind !== 'toolCall' || item.ev.tool !== 'Bash') continue
  const command = String((item.ev.input as any).command ?? '')
  const f = fromBash(command, item.ev.result)
  console.log(JSON.stringify(command).padEnd(70), 'pr=', JSON.stringify(f.pr), 'kick=', f.kick)
  if (f.pr) s = recordPr(s, f.pr)
}
console.log('proofs:', JSON.stringify(s.prs))

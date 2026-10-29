// usage: node extract.mjs <debug-file>...   one line per run: settle ms, problem lines, burst span, last problem line to settle line
import { readFileSync } from 'node:fs'
const at = l => Date.parse(l.slice(0, 24))
for (const f of process.argv.slice(2)) {
  const lines = readFileSync(f, 'utf8').split('\n')
  const probs = lines.filter(l => l.includes('$.ui.log (to debug): config: global.k'))
  const settle = lines.find(l => l.includes('artifact-tracking@inline session.start settled in'))
  const ms = Number(/settled in ([\d.]+)ms/.exec(settle)[1])
  const span = probs.length ? at(probs.at(-1)) - at(probs[0]) : 0
  const gap = probs.length ? at(settle) - at(probs.at(-1)) : 0
  const bad = lines.filter(l => /overran|lingering|budget/i.test(l)).length
  console.log(`${f}: settled ${ms} ms, ${probs.length} problem lines, first to last ${span} ms, last to settle ${gap} ms, budget lines ${bad}`)
}

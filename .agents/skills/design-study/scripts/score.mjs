#!/usr/bin/env node
// Scores a design study: per item, ranking (weakest first), weighted overall and gates.
// Rules: ../scoring.md. Usage: node score.mjs <items.json>   (or JSON on stdin)

import { readFileSync } from 'node:fs'

const FACTOR = { Feasible: 1, Partial: 0.75, Heuristic: 0.5, Untested: 0.3, 'Not feasible': 0 }
const WEIGHT = { Must: 3, Should: 2, Could: 1 }
const AXES = ['evidence', 'ease', 'safety']

function fail(msg) {
  console.error(`score.mjs: ${msg}`)
  process.exit(2)
}

const raw = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')
let input
try {
  input = JSON.parse(raw)
} catch (err) {
  fail(`input is not JSON: ${err.message}`)
}
if (!Array.isArray(input.items) || input.items.length === 0) fail('input needs a non-empty "items" array')

const items = input.items.map((it, i) => {
  const where = `item ${it.id ?? i + 1}`
  if (!(it.verdict in FACTOR)) fail(`${where}: verdict must be one of ${Object.keys(FACTOR).join(', ')}`)
  if (!(it.priority in WEIGHT)) fail(`${where}: priority must be Must, Should or Could`)
  for (const a of AXES) {
    if (!Number.isInteger(it[a]) || it[a] < 0 || it[a] > 5) fail(`${where}: ${a} must be an integer 0-5`)
  }
  // Evidence rule: only Not feasible and Untested may rest on Evidence below 4.
  let verdict = it.verdict
  let note = ''
  if (it.evidence < 4 && verdict !== 'Not feasible' && verdict !== 'Untested') {
    note = `${verdict} lowered to Untested (evidence ${it.evidence} < 4)`
    verdict = 'Untested'
  }
  const axes = 0.5 * it.evidence + 0.3 * it.ease + 0.2 * it.safety
  const score = Math.round(100 * FACTOR[verdict] * (axes / 5))
  return { ...it, verdict, note, score }
})

const totalWeight = items.reduce((s, it) => s + WEIGHT[it.priority], 0)
const mean = Math.round(items.reduce((s, it) => s + WEIGHT[it.priority] * it.score, 0) / totalWeight)

const musts = items.filter(it => it.priority === 'Must')
let overall
let reason
if (musts.some(it => it.verdict === 'Not feasible')) {
  overall = 'No-go'
  reason = `Must item not feasible: ${musts.filter(it => it.verdict === 'Not feasible').map(it => it.id).join(', ')}`
} else if (musts.some(it => it.verdict === 'Untested')) {
  overall = 'Spike first'
  reason = `Must item untested: ${musts.filter(it => it.verdict === 'Untested').map(it => it.id).join(', ')}`
} else if (mean >= 75) {
  overall = 'Go'
  reason = 'mean >= 75'
} else if (mean >= 55) {
  overall = 'Go with caveats'
  reason = 'mean 55-74'
} else {
  overall = 'Rethink scope'
  reason = 'mean < 55'
}

const ranked = [...items].sort((a, b) => a.score - b.score || WEIGHT[b.priority] - WEIGHT[a.priority])
const lines = []
if (input.feature) lines.push(`**${input.feature}**`, '')
lines.push('| Rank | Item | Priority | Verdict | Evidence | Ease | Safety | Score |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
ranked.forEach((it, i) => {
  const name = it.name ? `${it.id} ${it.name}` : it.id
  lines.push(`| ${i + 1} | ${name} | ${it.priority} | ${it.verdict} | ${it.evidence} | ${it.ease} | ${it.safety} | ${it.score} |`)
})
lines.push('', `**Overall: ${overall}** (${reason}). Weighted mean: ${mean}/100. Items are ranked weakest first.`)
const notes = items.filter(it => it.note)
if (notes.length > 0) {
  lines.push('', 'Evidence rule applied:')
  for (const it of notes) lines.push(`- ${it.id}: ${it.note}`)
}
console.log(lines.join('\n'))

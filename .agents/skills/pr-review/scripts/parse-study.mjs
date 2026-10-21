#!/usr/bin/env node
// Parses a design-study issue comment into requirement items with scores.
// Shapes: the design-study skill's templates.md and score.mjs output.
// A study has one score table per phase, each under a bold label line. The first
// table outside <details> that holds an item gives its scores. When the study has
// more than one table, `phases` lists the label of each table that holds the item.
// A score table inside <details> is a roll-up of the others. It runs after them
// and adds only the items no other table holds. A phase table must not sit inside
// <details>: its label is lost for an item that another table holds. Section 2
// rows add text, mechanism and caveat, and an item that only they name. A warning
// names each item with no verdict or no score, and each item on which two phases
// give a different verdict or a different evidence, ease, safety or score.
// Usage: node parse-study.mjs <comment.md>   (or the text on stdin)

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ID = /^(R\d+[a-z]*)\s*(.*)$/
const DASHES = /^[-–—\s]*$/

export function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}

// Each table also carries `label` (the whole-line bold text above it), `heading`
// (the last heading above it) and `inDetails` (inside <details>).
export function parseTables(md) {
  const tables = []
  let cur = null
  let label = null
  let heading = ''
  let details = 0
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) {
      cur = null
      const bold = /^\*\*([^*]+)\*\*$/.exec(line.trim())
      if (bold && !/^Overall:/i.test(bold[1])) label = bold[1].trim()
      const h = /^#{1,6}\s+(.*)$/.exec(line)
      if (h) {
        heading = h[1].trim()
        label = null
      }
      details += (line.match(/<details[\s>]/gi) ?? []).length - (line.match(/<\/details>/gi) ?? []).length
      continue
    }
    const cells = splitRow(line)
    if (!cur) {
      cur = { label, heading, inDetails: details > 0, header: cells.map((c) => c.toLowerCase()), rows: [] }
      label = null
      tables.push(cur)
      continue
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    cur.rows.push(Object.fromEntries(cur.header.map((h, i) => [h, cells[i] ?? ''])))
  }
  return tables
}

// Sections 1 (Score) and 2 (Feasibility) only: later tables reuse item ids.
function scoreAndFeasibility(md) {
  const start = md.search(/^### 1\./m)
  const end = md.search(/^### 3\./m)
  return start >= 0 && end > start ? md.slice(start, end) : md
}

const isScore = (t) => ['item', 'verdict', 'evidence', 'score'].every((h) => t.header.includes(h))
// A cell with no number gives null, never 0: Number('') is 0.
const num = (cell) => (/^\d+(\.\d+)?$/.test(cell ?? '') ? Number(cell) : null)
const noVerdict = (it) => DASHES.test(it.verdict)
const NUMBERS = ['evidence', 'ease', 'safety', 'score']

function scoreItem(row, m, phase) {
  return {
    id: m[1],
    name: m[2],
    text: m[2],
    priority: row.priority ?? row.pri ?? '',
    verdict: row.verdict ?? '',
    evidence: num(row.evidence),
    ease: num(row.ease),
    safety: num(row.safety),
    score: num(row.score),
    mechanism: '',
    caveat: '',
    labels: [phase],
  }
}

// A later table fills a blank of the first one. It never replaces a value. Two
// tables disagree when they give different values for the verdict or for any
// score axis (evidence, ease, safety, score). The warning names those fields.
function mergeRow(it, row, m, phase, warn) {
  const next = scoreItem(row, m, phase)
  const differs = [
    !noVerdict(it) && !noVerdict(next) && it.verdict !== next.verdict && 'verdict',
    ...NUMBERS.filter((k) => it[k] !== null && next[k] !== null && it[k] !== next[k]),
  ].filter(Boolean)
  if (differs.length) {
    const said = (x) => differs.map((k) => `${k} ${x[k]}`).join(', ')
    warn(`${it.id}: phases disagree ("${it.labels[0]}": ${said(it)}; "${phase}": ${said(next)}). Kept the first.`)
  }
  if (noVerdict(it)) it.verdict = next.verdict
  if (DASHES.test(it.priority)) it.priority = next.priority
  for (const k of NUMBERS) it[k] ??= next[k]
  if (!it.labels.includes(phase)) it.labels.push(phase)
}

export function parseStudy(md) {
  const head = md.match(/^## Design study:?[ \t]*(.*)$/m)
  if (!head) {
    if (/^## Design draft/m.test(md) || /^### Proposal/m.test(md)) {
      return { kind: 'draft', items: [], warnings: ['Design has no feasibility scores'] }
    }
    throw new Error('no design study or design draft found')
  }
  const verdict = md.match(/\*\*Overall:\s*([^*]+?)\*\*/)
  const mean = md.match(/weighted mean:?\s*(\d+)\s*\/\s*100/i)
  const tables = parseTables(scoreAndFeasibility(md))
  const scoreTables = tables.filter(isScore)
  const warnings = scoreTables.length ? [] : ['No score table found']
  const warn = (msg) => {
    if (!warnings.includes(msg)) warnings.push(msg)
  }
  const items = new Map()
  let used = 0
  // Tables outside <details> run first, so a roll-up adds only what they do not hold.
  const numbered = scoreTables.map((t, n) => ({ t, phase: t.label ?? `Score table ${n + 1}` }))
  const ordered = [...numbered.filter((x) => !x.t.inDetails), ...numbered.filter((x) => x.t.inDetails)]
  for (const { t, phase } of ordered) {
    let added = false
    for (const row of t.rows) {
      const m = ID.exec(row.item)
      if (!m) {
        warn(`Score row skipped: no item id in "${row.item}"`)
        continue
      }
      const it = items.get(m[1])
      if (it && t.inDetails) continue
      added = true
      if (it) mergeRow(it, row, m, phase, warn)
      else items.set(m[1], scoreItem(row, m, phase))
    }
    if (added) used++
  }
  for (const t of tables) {
    if (isScore(t) || !t.header.includes('item')) continue
    for (const row of t.rows) {
      const m = ID.exec(row.item)
      if (!m) continue
      let it = items.get(m[1])
      if (!it) {
        if (!scoreTables.length || !/^2\./.test(t.heading)) continue
        it = { ...scoreItem({ ...row, verdict: '' }, m), score: null, labels: [] }
        items.set(m[1], it)
      }
      if (DASHES.test(it.priority)) it.priority = row.priority || row.pri || ''
      if (m[2].length > it.text.length) it.text = m[2]
      if (row.mechanism && !it.mechanism) it.mechanism = row.mechanism
      if (row.caveat && !it.caveat) it.caveat = row.caveat
    }
  }
  for (const it of items.values()) {
    if (!it.labels.length) {
      warn(`${it.id}: in section 2 but in no score table, so no verdict and no score`)
      continue
    }
    const missing = [noVerdict(it) && 'verdict', it.score === null && 'score'].filter(Boolean)
    if (missing.length) warn(`${it.id}: no ${missing.join(' and no ')}`)
  }
  return {
    kind: 'study',
    title: head[1].trim(),
    overall: verdict ? { verdict: verdict[1].trim(), mean: mean ? Number(mean[1]) : null } : null,
    items: [...items.values()]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map(({ labels, ...it }) => (used > 1 ? { ...it, phases: labels } : it)),
    warnings,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')
  try {
    console.log(JSON.stringify(parseStudy(raw), null, 2))
  } catch (err) {
    console.error(`parse-study.mjs: ${err.message}`)
    process.exit(2)
  }
}

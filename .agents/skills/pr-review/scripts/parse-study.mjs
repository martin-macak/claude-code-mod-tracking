#!/usr/bin/env node
// Parses a design-study issue comment into requirement items with scores.
// Shapes: the design-study skill's templates.md and score.mjs output.
// Usage: node parse-study.mjs <comment.md>   (or the text on stdin)

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ID = /^(R\d+[a-z]*)\s*(.*)$/

export function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}

export function parseTables(md) {
  const tables = []
  let cur = null
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) {
      cur = null
      continue
    }
    const cells = splitRow(line)
    if (!cur) {
      cur = { header: cells.map((c) => c.toLowerCase()), rows: [] }
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
  const score = tables.find((t) => ['item', 'verdict', 'evidence', 'score'].every((h) => t.header.includes(h)))
  const warnings = score ? [] : ['No score table found']
  const items = new Map()
  for (const row of score?.rows ?? []) {
    const m = ID.exec(row.item)
    if (!m) {
      warnings.push(`Score row skipped: no item id in "${row.item}"`)
      continue
    }
    items.set(m[1], {
      id: m[1],
      name: m[2],
      text: m[2],
      priority: row.priority,
      verdict: row.verdict,
      evidence: Number(row.evidence),
      ease: Number(row.ease),
      safety: Number(row.safety),
      score: Number(row.score),
      mechanism: '',
      caveat: '',
    })
  }
  for (const t of tables) {
    if (t === score || !t.header.includes('item')) continue
    for (const row of t.rows) {
      const m = ID.exec(row.item)
      const it = m && items.get(m[1])
      if (!it) continue
      if (m[2].length > it.text.length) it.text = m[2]
      if (row.mechanism && !it.mechanism) it.mechanism = row.mechanism
      if (row.caveat && !it.caveat) it.caveat = row.caveat
    }
  }
  return {
    kind: 'study',
    title: head[1].trim(),
    overall: verdict ? { verdict: verdict[1].trim(), mean: mean ? Number(mean[1]) : null } : null,
    items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
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

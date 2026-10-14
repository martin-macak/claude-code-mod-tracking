import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runWorkflow } from './run-workflow.mjs'

const ARGS = {
  pr: { number: 42, title: 'feat: X', base: 'b'.repeat(40), head: 'h'.repeat(40), files: ['a.ts'] },
  issue: { number: 31, title: 'X', source: 'closing' },
  design: { kind: 'study', overall: { verdict: 'Go', mean: 80 } },
  items: [
    { id: 'R1', text: 'one', priority: 'Must' },
    { id: 'R2', text: 'two', priority: 'Must' },
    { id: 'R3', text: 'three', priority: 'Should' },
    { id: 'R4', text: 'four', priority: 'Could' },
  ],
  threads: [],
  findings: [],
  jev: true,
}

const finding = (over) => ({
  lens: 'quality',
  severity: 'Minor',
  title: 't',
  file: 'a.ts',
  line: 10,
  item: null,
  problem: 'p',
  evidence: 'e',
  fix: 'f',
  ...over,
})

const traceResult = (id, status) => ({
  id,
  status,
  correct: status === 'Implemented',
  code: [],
  tests: [],
  reason: 'r',
  judgment: { source: 'jev', answer: 'yes', confidence: 0.9 },
})

// Default fake: R1 Implemented, R2 Not implemented, R3 Partial, R4 Inconclusive.
// Lenses return `lensFindings[key]`. Verify keeps all unless `refute[key]` names an index.
function fake({ status = {}, lensFindings = {}, refute = {}, fail = [], merges = [], synthesis = '## PR review: X' } = {}) {
  const st = { R1: 'Implemented', R2: 'Not implemented', R3: 'Partial', R4: 'Inconclusive', ...status }
  return async (prompt, opts) => {
    if (fail.includes(opts.label)) return null
    const [kind, key] = opts.label.split(':')
    if (kind === 'trace') return { results: key.split(',').map((id) => traceResult(id, st[id])), findings: [] }
    if (kind === 'reassess')
      return {
        id: key,
        verdict: 'Feasible',
        evidence: 4,
        ease: 4,
        safety: 4,
        missed: 'None',
        proposal: `do ${key}`,
        files: [`src/${key}.ts:1`],
      }
    if (kind === 'lens') return { findings: lensFindings[key] ?? [] }
    if (kind === 'verify') {
      const n = (prompt.match(/^\[\d+\]/gm) ?? []).length
      return {
        verdicts: Array.from({ length: n }, (_, i) => ({
          index: i,
          refuted: (refute[key] ?? []).includes(i),
          reason: 'r',
          severity: null,
          judgment: { source: 'own', answer: 'ok' },
        })),
      }
    }
    if (kind === 'dedup') return { merges }
    if (kind === 'synthesis') return synthesis
    throw new Error(`unexpected label ${opts.label}`)
  }
}

const noItems = { ...ARGS, items: [] }

test('only items that are not Implemented reach Reassess', async () => {
  const { calls } = await runWorkflow({ args: ARGS, agent: fake() })
  const reassessed = calls.filter((c) => c.opts.label.startsWith('reassess:')).map((c) => c.opts.label)
  assert.deepEqual(reassessed.sort(), ['reassess:R2', 'reassess:R3', 'reassess:R4'])
})

test('items go to Trace in batches of 3 on sonnet, Reassess runs on opus', async () => {
  const { calls } = await runWorkflow({ args: ARGS, agent: fake() })
  const trace = calls.filter((c) => c.opts.label.startsWith('trace:'))
  assert.deepEqual(
    trace.map((c) => c.opts.label),
    ['trace:R1,R2,R3', 'trace:R4'],
  )
  assert.ok(trace.every((c) => c.opts.model === 'sonnet'))
  assert.ok(calls.filter((c) => c.opts.label.startsWith('reassess:')).every((c) => c.opts.model === 'opus'))
})

test('open items with no finding get a requirements finding from the gap table', async () => {
  const { result } = await runWorkflow({ args: ARGS, agent: fake() })
  const req = result.findings.filter((f) => f.lens === 'requirements')
  const byItem = Object.fromEntries(req.map((f) => [f.item, f]))
  assert.equal(byItem.R2.severity, 'Critical') // Must, Not implemented
  assert.equal(byItem.R3.severity, 'Major') // Should, Partial
  assert.equal(byItem.R4.severity, 'Minor') // Could, Inconclusive
  assert.equal(byItem.R2.fix, 'do R2')
  assert.deepEqual([byItem.R2.file, byItem.R2.line], ['src/R2.ts', 1])
  assert.equal(byItem.R1, undefined)
})

test('a refuted finding is dropped and listed under refuted', async () => {
  const lensFindings = { quality: [finding({ title: 'keep', line: 10 }), finding({ title: 'drop', line: 50 })] }
  const { result, logs } = await runWorkflow({
    args: ARGS,
    agent: fake({ lensFindings, refute: { quality: [1] } }),
  })
  assert.ok(result.findings.some((f) => f.title === 'keep'))
  assert.ok(!result.findings.some((f) => f.title === 'drop'))
  assert.deepEqual(
    result.refuted.map((f) => f.title),
    ['drop'],
  )
  assert.ok(logs.some((l) => /refuted 1/.test(l)))
})

test('duplicates merge and keep the highest severity', async () => {
  const lensFindings = {
    quality: [finding({ severity: 'Minor', line: 10, fix: 'a' }), finding({ severity: 'Major', line: 12, fix: 'b' })],
  }
  const { result } = await runWorkflow({ args: noItems, agent: fake({ lensFindings }) })
  const q = result.findings.filter((f) => f.lens === 'quality')
  assert.equal(q.length, 1)
  assert.equal(q[0].severity, 'Major')
  assert.match(q[0].fix, /b[\s\S]*a/)
})

test('findings from different lenses on nearby lines stay apart', async () => {
  const lensFindings = { quality: [finding({ line: 10 })], tests: [finding({ lens: 'tests', line: 11 })] }
  const { result } = await runWorkflow({ args: noItems, agent: fake({ lensFindings }) })
  assert.equal(result.findings.length, 2)
})

test('findings sort by severity, then file, then line', async () => {
  const lensFindings = {
    quality: [
      finding({ severity: 'Nit', file: 'a.ts', line: 1 }),
      finding({ severity: 'Major', file: 'b.ts', line: 90 }),
    ],
    architecture: [finding({ lens: 'architecture', severity: 'Major', file: 'a.ts', line: 200 })],
  }
  const { result } = await runWorkflow({ args: noItems, agent: fake({ lensFindings }) })
  assert.deepEqual(
    result.findings.map((f) => `${f.severity} ${f.file}:${f.line}`),
    ['Major a.ts:200', 'Major b.ts:90', 'Nit a.ts:1'],
  )
})

test('verdict: Critical gives Not ready, Major gives Ready after fixes, else Ready', async () => {
  const notReady = await runWorkflow({ args: ARGS, agent: fake() })
  assert.equal(notReady.result.verdict, 'Not ready')
  const major = await runWorkflow({
    args: noItems,
    agent: fake({ lensFindings: { quality: [finding({ severity: 'Major' })] } }),
  })
  assert.equal(major.result.verdict, 'Ready after fixes')
  const ready = await runWorkflow({
    args: noItems,
    agent: fake({ lensFindings: { quality: [finding({ severity: 'Nit' })] } }),
  })
  assert.equal(ready.result.verdict, 'Ready')
  assert.deepEqual(ready.result.counts, { Critical: 0, Major: 0, Minor: 0, Nit: 1 })
})

test('a dead trace agent makes its items Inconclusive and still reassesses them', async () => {
  const { result, logs } = await runWorkflow({ args: ARGS, agent: fake({ fail: ['trace:R4'] }) })
  const r4 = result.items.find((i) => i.id === 'R4')
  assert.equal(r4.status, 'Inconclusive')
  assert.equal(r4.reassess.verdict, 'Feasible')
  assert.ok(logs.some((l) => /trace:R4.*no result/.test(l)))
  assert.ok(result.dropped.some((d) => /trace:R4/.test(d)))
})

test('a dead lens agent is logged and dropped, the review goes on', async () => {
  const { result, logs } = await runWorkflow({ args: noItems, agent: fake({ fail: ['lens:tests'] }) })
  assert.ok(logs.some((l) => /lens:tests.*no result/.test(l)))
  assert.ok(result.dropped.some((d) => /lens:tests/.test(d)))
  assert.equal(result.review, '## PR review: X')
})

test('no items: Trace is skipped and logged, lenses still run', async () => {
  const { calls, logs } = await runWorkflow({ args: noItems, agent: fake() })
  assert.ok(!calls.some((c) => c.opts.label.startsWith('trace:')))
  assert.equal(calls.filter((c) => c.opts.label.startsWith('lens:')).length, 3)
  assert.ok(logs.some((l) => /No requirement items/.test(l)))
})

test('scout findings from args pass through verify into the result', async () => {
  const scout = finding({ lens: 'requirements', severity: 'Major', title: 'No linked issue', file: 'PR body', line: null })
  const { result, calls } = await runWorkflow({ args: { ...noItems, findings: [scout] }, agent: fake() })
  assert.ok(calls.some((c) => c.opts.label === 'verify:scout'))
  assert.ok(result.findings.some((f) => f.title === 'No linked issue'))
})

test('synthesis gets the merged data and runs on opus', async () => {
  const { calls } = await runWorkflow({ args: ARGS, agent: fake() })
  const synth = calls.find((c) => c.opts.label === 'synthesis')
  assert.equal(synth.opts.model, 'opus')
  assert.match(synth.prompt, /templates\.md/)
  assert.match(synth.prompt, /"verdict": "Not ready"/)
})

test('the verify prompt carries each severity text from severity.md', async () => {
  const md = readFileSync(new URL('../severity.md', import.meta.url), 'utf8')
  const rows = [...md.matchAll(/^\| `(Critical|Major|Minor|Nit)` \| (.+) \|$/gm)].map((m) => [m[1], m[2]])
  assert.equal(rows.length, 4)
  const lensFindings = { quality: [finding({})] }
  const { calls } = await runWorkflow({ args: noItems, agent: fake({ lensFindings }) })
  const prompt = calls.find((c) => c.opts.label === 'verify:quality').prompt
  for (const [level, text] of rows) assert.ok(prompt.includes(`- ${level}: ${text}`), level)
})

test('text before the review heading is cut from the review body', async () => {
  const { result } = await runWorkflow({
    args: noItems,
    agent: fake({ synthesis: '[harness: note]\n\n## PR review: X\nbody' }),
  })
  assert.equal(result.review, '## PR review: X\nbody')
})

test('with Jev, trace and verify prompts name their Jev call and require source jev', async () => {
  const lensFindings = { quality: [finding({})] }
  const { calls } = await runWorkflow({ args: ARGS, agent: fake({ lensFindings }) })
  const trace = calls.find((c) => c.opts.label.startsWith('trace:')).prompt
  const verify = calls.find((c) => c.opts.label === 'verify:quality').prompt
  assert.match(trace, /jev_check once per item/)
  assert.match(verify, /jev_classify once per finding/)
  for (const p of [trace, verify]) assert.match(p, /judgment\.source must be "jev" unless the jev_\* tools fail to load/)
})

test('without Jev, prompts do not ask for Jev calls', async () => {
  const lensFindings = { quality: [finding({})] }
  const { calls } = await runWorkflow({ args: { ...ARGS, jev: false }, agent: fake({ lensFindings }) })
  assert.ok(calls.every((c) => !/jev_(check|classify|ask)/.test(c.prompt)))
})

test('the dedup agent merges same-problem findings from different lenses', async () => {
  const lensFindings = {
    quality: [finding({ severity: 'Minor', line: 10, fix: 'a', title: 'git runs inline' })],
    architecture: [finding({ lens: 'architecture', severity: 'Major', line: 14, fix: 'b', title: 'git on hot path' })],
  }
  const { result, calls } = await runWorkflow({
    args: noItems,
    agent: fake({ lensFindings, merges: [{ a: 0, b: 1 }] }),
  })
  const dedup = calls.find((c) => c.opts.label === 'dedup')
  assert.equal(dedup.opts.model, 'sonnet')
  assert.match(dedup.prompt, /jev_check once per pair/)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].severity, 'Major')
  assert.equal(result.findings[0].title, 'git on hot path')
  assert.deepEqual(result.findings[0].lenses, ['architecture', 'quality'])
  assert.match(result.findings[0].fix, /b[\s\S]*a/)
  assert.equal(result.verdict, 'Ready after fixes')
})

test('no dedup agent runs when no findings share a file region across lenses', async () => {
  const lensFindings = { quality: [finding({ line: 10 })], tests: [finding({ lens: 'tests', line: 40 })] }
  const { calls } = await runWorkflow({ args: noItems, agent: fake({ lensFindings }) })
  assert.ok(!calls.some((c) => c.opts.label === 'dedup'))
})

test('a dead dedup agent keeps all findings and is logged as dropped', async () => {
  const lensFindings = { quality: [finding({ line: 10 })], tests: [finding({ lens: 'tests', line: 11 })] }
  const { result } = await runWorkflow({ args: noItems, agent: fake({ lensFindings, fail: ['dedup'] }) })
  assert.equal(result.findings.length, 2)
  assert.ok(result.dropped.some((d) => /dedup/.test(d)))
})

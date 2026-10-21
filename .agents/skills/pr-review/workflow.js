export const meta = {
  name: 'pr-review',
  description: 'Review a PR against its issue and design: trace items, reassess open items, lens review, verify, merge',
  whenToUse: 'Started by the pr-review skill with the args it scouted. Not for direct use.',
  phases: [
    { title: 'Trace', detail: 'one agent per batch of 3 requirement items', model: 'sonnet' },
    { title: 'Reassess', detail: 'feasibility and a proposal per item not Implemented', model: 'opus' },
    { title: 'Lenses', detail: 'architecture, code quality, tests', model: 'sonnet' },
    { title: 'Verify', detail: 'a skeptic per finding batch sets the severity', model: 'sonnet' },
    { title: 'Synthesis', detail: 'merge, dedup across lenses, write the review body', model: 'opus' },
  ],
}

// Spec: docs/superpowers/specs/2026-10-14-pr-review-skill-design.md
// args: { pr: { number, title, base, head, files }, issue: { number, title, source } | null,
//   design: { kind, overall } | null, items: [{ id, text, priority, study?: { verdict, score, mechanism, caveat, phases? } }],
//   threads: [{ path, line, body }], findings: [finding], jev: boolean }
// Without the Workflow tool, run each agent() step below yourself, in order.

const SKILL = '.agents/skills/pr-review'
const BATCH = 3
const SEVERITY = ['Critical', 'Major', 'Minor', 'Nit']
// Same text as severity.md. A test keeps them equal.
const SEVERITY_TEXT = {
  Critical:
    'Wrong behavior, data loss, a privacy leak, a crash or a blocked session, or a `Must` item not implemented. Blocks the merge.',
  Major:
    'A requirement only partly met, changed behavior without a test, or a design flaw that will force a rework. Fix before the merge.',
  Minor: 'A quality or clarity problem with low risk. Fix in this PR when cheap, else file a follow-up.',
  Nit: 'Style or wording. Optional.',
}
const LENSES = ['architecture', 'quality', 'tests']
// Severity of a requirements finding for an open item: [status][priority].
const GAP = {
  'Not implemented': { Must: 'Critical', Should: 'Major', Could: 'Minor' },
  Partial: { Must: 'Major', Should: 'Major', Could: 'Minor' },
  Inconclusive: { Must: 'Minor', Should: 'Minor', Could: 'Minor' },
}

const JUDGMENT = {
  type: 'object',
  properties: { source: { enum: ['jev', 'own'] }, answer: { type: 'string' }, confidence: { type: 'number' } },
  required: ['source', 'answer'],
}
const FINDING = {
  type: 'object',
  properties: {
    lens: { enum: ['architecture', 'quality', 'tests', 'requirements'] },
    severity: { enum: SEVERITY },
    title: { type: 'string' },
    file: { type: 'string' },
    line: { type: ['integer', 'null'] },
    item: { type: ['string', 'null'] },
    problem: { type: 'string' },
    evidence: { type: 'string' },
    fix: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['lens', 'severity', 'title', 'file', 'line', 'problem', 'evidence', 'fix'],
}
const TRACE = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { enum: ['Implemented', 'Partial', 'Not implemented', 'Inconclusive'] },
          correct: { type: 'boolean' },
          code: { type: 'array', items: { type: 'string' } },
          tests: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          judgment: JUDGMENT,
        },
        required: ['id', 'status', 'correct', 'code', 'tests', 'reason', 'judgment'],
      },
    },
    findings: { type: 'array', items: FINDING },
  },
  required: ['results', 'findings'],
}
const AXIS = { type: 'integer', minimum: 0, maximum: 5 }
const REASSESS = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    verdict: { enum: ['Feasible', 'Partial', 'Heuristic', 'Untested', 'Not feasible'] },
    evidence: AXIS,
    ease: AXIS,
    safety: AXIS,
    missed: { type: 'string' },
    proposal: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    judgment: JUDGMENT,
  },
  required: ['id', 'verdict', 'evidence', 'ease', 'safety', 'missed', 'proposal', 'files'],
}
const LENS = { type: 'object', properties: { findings: { type: 'array', items: FINDING } }, required: ['findings'] }
const DEDUP = {
  type: 'object',
  properties: {
    merges: {
      type: 'array',
      items: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
    },
  },
  required: ['merges'],
}
const VERIFY = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          refuted: { type: 'boolean' },
          reason: { type: 'string' },
          severity: { enum: [...SEVERITY, null] },
          judgment: JUDGMENT,
        },
        required: ['index', 'refuted', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const pr = args.pr
const threads = args.threads ?? []
const scoutFindings = args.findings ?? []
const dropped = []
const drop = (label, why) => {
  dropped.push(`${label}: ${why}`)
  log(`${label}: ${why}`)
}

const CONTEXT = [
  `PR #${pr.number} "${pr.title}". Base ${pr.base}, head ${pr.head}.`,
  args.issue
    ? `Linked issue #${args.issue.number} "${args.issue.title}" (${args.issue.source}).`
    : 'No linked issue.',
  `Read the change with \`git diff ${pr.base}...${pr.head}\` and files with \`git show ${pr.head}:<path>\`.`,
  'Never check out the branch. Never edit files. Every finding names file and line and gives a concrete fix.',
].join('\n')
const DECIDE = args.jev
  ? 'Decision model: load the jev_* tools with ToolSearch ("jev"). A Jev answer is a proposal. On review, abstain or uncertain, read the evidence and decide yourself. Put the answer and confidence in judgment. judgment.source must be "jev" unless the jev_* tools fail to load; then judge yourself, source "own", and say why.'
  : 'No decision model. Judge yourself, set judgment.source to "own" and give a one-line reason in judgment.answer.'
const THREADS = threads.length
  ? `Open review threads. Do not repeat them; cite them when relevant:\n${JSON.stringify(threads, null, 2)}`
  : 'No open review threads.'
const LEVELS = SEVERITY.map((s) => `- ${s}: ${SEVERITY_TEXT[s]}`).join('\n')

const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))
const rank = (s) => SEVERITY.indexOf(s)
const byOrder = (a, b) =>
  rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || (a.line ?? -1) - (b.line ?? -1)
const near = (a, b) => (a.line == null || b.line == null ? a.line === b.line : Math.abs(a.line - b.line) <= 3)
const normalizeItem = (finding, ids = new Set()) => ({
  ...finding,
  item: finding.item != null && ids.has(finding.item) ? finding.item : null,
})
const isDup = (a, b) => a.file === b.file && near(a, b) && (a.lens === b.lens || (a.item != null && a.item === b.item))
const fileLine = (ref) => {
  const m = /^(.*?):(\d+)/.exec(ref ?? '')
  return m ? [m[1], Number(m[2])] : [ref || '(not in the diff)', null]
}

function tracePrompt(batch) {
  return [
    'Trace each requirement item against the PR. For each item decide:',
    '- status: Implemented, Partial, Not implemented or Inconclusive (you cannot decide from the code and tests).',
    '- correct: the code does what the item says, exactly and accurately, including edge cases the item names.',
    '- code and tests: "path:line" and "path:line test name" that prove it. An item with no test is at most Partial.',
    args.jev
      ? 'Call jev_check once per item: "Does this change implement this requirement correctly?" State: the item, its study mechanism and caveat, the cited code and test.'
      : 'One judgment per item: "Does this change implement this requirement correctly?"',
    'Add a finding (lens "requirements", item id set) for each item that is wrong, partly done, or done in a way the issue did not ask for.',
    CONTEXT,
    DECIDE,
    THREADS,
    `Items:\n${JSON.stringify(batch, null, 2)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function reassessPrompt(item, result) {
  return [
    `Item ${item.id} is "${result.status}" in this PR. Reason: ${result.reason}`,
    'The first feasibility study may have missed a path. Assess the item again from scratch on the repo at the PR head:',
    '- verdict, evidence, ease, safety: use the levels in .agents/skills/design-study/scoring.md. Feasible, Partial and Heuristic need evidence >= 4.',
    '- missed: what the first study or the PR missed, or "None".',
    '- proposal: how to implement or fix the item: files, the change, and the test that must fail first.',
    '- files: "path:line" where the change goes, most important first.',
    args.jev
      ? 'Score with one jev_ask per item: Ease and Safety as score questions, the verdict as classify, as in scoring.md "Jev call for one item".'
      : '',
    CONTEXT,
    DECIDE,
    `Item:\n${JSON.stringify(item, null, 2)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function lensPrompt(lens) {
  return [
    `Review the PR under the "${lens}" lens only. The checklist is in ${SKILL}/lenses.md, section "${lens}".`,
    'Report only real problems in the changed code. Each finding: severity, title, file, line, item, problem, evidence (quote the code), fix.',
    '"item": the requirement id (R1, R5a, …) the finding is about, or null. Never a checklist row name or a free-text label.',
    'The fix is concrete: a code snippet, or a GitHub suggestion block in "suggestion" when the fix replaces the cited lines.',
    `Severity levels:\n${LEVELS}`,
    CONTEXT,
    THREADS,
    `Changed files:\n${pr.files.join('\n')}`,
  ].join('\n\n')
}

function verifyPrompt(key, findings) {
  return [
    `You are a skeptic. Try to refute each "${key}" finding below against the code at the PR head.`,
    'refuted = true when the code does not show the problem, the fix is wrong, or the finding repeats an open thread.',
    `For a finding that stands, set the severity. Options (classify):\n${LEVELS}`,
    args.jev ? 'Call jev_classify once per finding with these options. State: the finding and the quoted code.' : '',
    CONTEXT,
    DECIDE,
    findings.map((f, i) => `[${i}] ${JSON.stringify(f)}`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function verify(key, findings) {
  if (!findings.length) return { kept: [], refuted: [] }
  const label = `verify:${key}`
  const out = await agent(verifyPrompt(key, findings), { label, phase: 'Verify', schema: VERIFY, model: 'sonnet' })
  if (!out) {
    drop(label, `no result, ${findings.length} findings kept unverified`)
    return { kept: findings.map((f) => ({ ...f, verified: false })), refuted: [] }
  }
  const kept = []
  const refuted = []
  findings.forEach((f, i) => {
    const v = out.verdicts.find((x) => x.index === i)
    if (v?.refuted) refuted.push({ ...f, reason: v.reason })
    else kept.push({ ...f, severity: v?.severity ?? f.severity, verified: Boolean(v), judgment: v?.judgment })
  })
  if (refuted.length) log(`${label}: refuted ${refuted.length} of ${findings.length}`)
  return { kept, refuted }
}

async function trace(batch) {
  const label = `trace:${batch.map((i) => i.id).join(',')}`
  const out = await agent(tracePrompt(batch), { label, phase: 'Trace', schema: TRACE, model: 'sonnet' })
  if (out) return out
  drop(label, 'no result, items marked Inconclusive')
  return {
    results: batch.map((i) => ({
      id: i.id,
      status: 'Inconclusive',
      correct: false,
      code: [],
      tests: [],
      reason: 'The trace agent gave no result.',
    })),
    findings: [],
  }
}

async function settle(out, batch) {
  const open = out.results.filter((r) => r.status !== 'Implemented')
  const [reassess, checked] = await Promise.all([
    Promise.all(
      open.map(async (r) => {
        const item = batch.find((i) => i.id === r.id) ?? { id: r.id }
        const label = `reassess:${r.id}`
        const res = await agent(reassessPrompt(item, r), { label, phase: 'Reassess', schema: REASSESS, model: 'opus' })
        if (!res) drop(label, 'no result')
        return res
      }),
    ),
    verify(`requirements:${batch.map((i) => i.id).join(',')}`, out.findings),
  ])
  return { results: out.results, reassess: reassess.filter(Boolean), ...checked }
}

async function lens(key) {
  const out = await agent(lensPrompt(key), { label: `lens:${key}`, phase: 'Lenses', schema: LENS, model: 'sonnet' })
  if (!out) drop(`lens:${key}`, 'no result')
  return out?.findings ?? []
}

function gapFindings(items, results, reassess, findings) {
  return results
    .filter((r) => r.status !== 'Implemented' && !findings.some((f) => f.item === r.id))
    .map((r) => {
      const item = items.find((i) => i.id === r.id) ?? { priority: 'Must', text: r.id }
      const plan = reassess.find((x) => x.id === r.id)
      const [file, line] = fileLine(plan?.files?.[0] ?? r.code[0])
      return {
        lens: 'requirements',
        severity: GAP[r.status][item.priority] ?? 'Major',
        title: `${r.id} ${r.status.toLowerCase()}: ${item.text}`,
        file,
        line,
        item: r.id,
        problem: r.reason,
        evidence: r.code.length ? r.code.join(', ') : 'No code or test in the diff covers it.',
        fix: plan?.proposal ?? `Implement ${r.id} and add a test that fails without it.`,
      }
    })
}

// Pairs that may be one problem seen by two lenses. A judgment decides; a line rule cannot.
function candidatePairs(findings) {
  const pairs = []
  findings.forEach((a, i) => {
    findings.forEach((b, j) => {
      if (j <= i || a.file !== b.file || a.lens === b.lens) return
      if (a.line == null || b.line == null || Math.abs(a.line - b.line) > 5) return
      if (a.item != null && b.item != null && a.item !== b.item) return
      pairs.push({ a: i, b: j })
    })
  })
  return pairs
}

function dedupPrompt(findings, pairs) {
  return [
    'Some findings below may describe the same problem, seen by two lenses. For each candidate pair, decide: do both findings describe the same problem in the code?',
    'Return in merges only the pairs that do. Two different problems on the same lines are not the same problem.',
    args.jev
      ? 'Call jev_check once per pair: "Do these two findings describe the same problem in the code?" State: both findings.'
      : '',
    DECIDE,
    `Findings:\n${findings.map((f, i) => `[${i}] ${JSON.stringify(f)}`).join('\n')}`,
    `Candidate pairs:\n${JSON.stringify(pairs)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function dedup(findings) {
  const pairs = candidatePairs(findings)
  if (!pairs.length) return findings
  const out = await agent(dedupPrompt(findings, pairs), { label: 'dedup', phase: 'Synthesis', schema: DEDUP, model: 'sonnet' })
  if (!out) {
    drop('dedup', `no result, ${pairs.length} candidate pairs kept apart`)
    return findings
  }
  const parent = findings.map((_, i) => i)
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])))
  for (const m of out.merges) {
    if (pairs.some((p) => p.a === m.a && p.b === m.b)) parent[root(m.b)] = root(m.a)
  }
  const groups = new Map()
  findings.forEach((f, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), f]))
  return [...groups.values()]
    .map((g) => {
      const list = [...g].sort((x, y) => rank(x.severity) - rank(y.severity))
      const [base, ...rest] = list
      if (!rest.length) return base
      const item = list.find((f) => f.item != null)?.item ?? base.item ?? null
      const fixes = [base.fix, ...rest.map((f) => f.fix).filter((x) => x !== base.fix)]
      return { ...base, item, lenses: [...new Set(g.map((f) => f.lens))].sort(), fix: fixes.join('\n\nAlso: ') }
    })
    .sort(byOrder)
}

function merge(findings) {
  const out = []
  for (const f of [...findings].sort((a, b) => rank(a.severity) - rank(b.severity))) {
    const d = out.find((o) => isDup(o, f))
    if (!d) out.push({ ...f })
    else if (d.fix !== f.fix) d.fix = `${d.fix}\n\nAlso: ${f.fix}`
  }
  return out.sort(byOrder)
}

// --- Run ---

const batches = chunk(args.items, BATCH)
if (!batches.length) log('No requirement items: Trace and Reassess skipped.')
phase('Trace')
const [traced, lensed, scout] = await Promise.all([
  pipeline(batches, trace, settle),
  pipeline(LENSES, lens, (found, key) => verify(key, found)),
  verify('scout', scoutFindings),
])

const settled = traced.filter(Boolean)
const results = settled.flatMap((s) => s.results)
const reassess = settled.flatMap((s) => s.reassess)
const verified = [...settled, ...lensed.filter(Boolean), scout]
const kept = verified.flatMap((v) => v.kept)
const refuted = verified.flatMap((v) => v.refuted)
const ids = new Set(args.items.map((i) => i.id))
const normalized = kept.map((finding) => normalizeItem(finding, ids))
phase('Synthesis')
const findings = await dedup(merge([...normalized, ...gapFindings(args.items, results, reassess, normalized)]))
const counts = Object.fromEntries(SEVERITY.map((s) => [s, findings.filter((f) => f.severity === s).length]))
const verdict = counts.Critical ? 'Not ready' : counts.Major ? 'Ready after fixes' : 'Ready'
const items = results.map((r) => {
  const item = args.items.find((i) => i.id === r.id)
  return { ...r, priority: item?.priority, study: item?.study, reassess: reassess.find((x) => x.id === r.id) }
})
log(
  `Findings: ${SEVERITY.map((s) => `${counts[s]} ${s}`).join(', ')}. Refuted ${refuted.length}. Verdict: ${verdict}.`,
)

const data = { verdict, counts, items, findings, refuted, dropped, issue: args.issue, design: args.design, jev: args.jev }
const written = await agent(
  [
    `Write the review body for PR #${pr.number}. Fill every slot of the template in ${SKILL}/templates.md. Write "None" for an empty slot.`,
    'Keep each finding, its severity and its fix. You may tighten the wording. Never drop a finding or change a severity.',
    'Section 2: run `node .agents/skills/design-study/scripts/score.mjs` on the reassessed items (priority from the item) and paste its output.',
    'Return only the Markdown body. Keep it under 60,000 characters: collapse the Nit section into <details> first.',
    `Data:\n${JSON.stringify(data, null, 2)}`,
  ].join('\n\n'),
  { label: 'synthesis', phase: 'Synthesis', model: 'opus' },
)
if (!written) drop('synthesis', 'no result, write the body from the data')
// Harness notes can precede the body. Post only the review itself.
const start = written ? written.indexOf('## PR review') : -1
const review = start > 0 ? written.slice(start) : written

return { ...data, review }

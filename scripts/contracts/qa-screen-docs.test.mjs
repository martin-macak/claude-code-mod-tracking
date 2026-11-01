// The KB keeps the verdict of the spike #196 and the build #246: can a CommandOutput rewrite keep /track qa from the model?
// Nothing else reads that section, so it could change or vanish with CI green. This contract pins its anchors, taken from the code
// where the code owns them (the stub, the row limit). It also pins the study ids that the evidence table cites, the links of the
// section, the open questions and the scrub of the probe sources. The kit has no fs, so it runs under node in `make test-scripts`.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/qa-screen-docs.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { qaStub, SCREEN_LIMIT } from '../../plugins/artifact-tracking/trackers/questions/markdown.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const KB = join(ROOT, 'docs/knowledge-base/claude-code-mods')
const read = path => readFileSync(join(KB, path), 'utf8')
const PAGE_PATH = 'concepts/questions-and-plans.md'
const PAGE = read(PAGE_PATH)
const HEADING = '## Keeping `/track qa` from the model'
const FEATURE = readFileSync(join(ROOT, 'e2e/features/questions.feature'), 'utf8')

/** The section of the page, from its heading to the next `## `. */
function section() {
  const start = PAGE.indexOf(HEADING)
  assert.ok(start >= 0, `${PAGE_PATH} has the heading "${HEADING}"`)
  const next = PAGE.indexOf('\n## ', start + HEADING.length)
  return PAGE.slice(start, next < 0 ? undefined : next)
}

const call = n => ({ n, id: `id-${n}`, at: 0, kind: 'ask', items: [] })

test('the verdict line names every grade and the three versions', () => {
  const verdict = section()
    .split('\n')
    .find(l => l.startsWith('Verdict:'))
  assert.ok(verdict, 'the section has a "Verdict:" line')
  for (const word of ['verified-live', 'verified-kit', 'types-only', '2.1.310', '2.1.311', '2.1.312'])
    assert.ok(verdict.includes(word), `the verdict names ${word}`)
})

test('the section and the e2e feature quote the stub as the code builds it', () => {
  const many = qaStub([1, 2, 3, 4, 5, 6, 7].map(call), '')
  assert.ok(many, 'the stub of seven calls')
  const start = many.slice(0, many.indexOf(' /track qa --send'))
  assert.equal(start, 'Questions and answers Q1–Q7 (7 calls): drawn on the screen only.')
  assert.ok(section().includes(start), 'the diagram quotes the stub')
  const one = qaStub([call(3)], '')
  assert.ok(one?.startsWith('Questions and answers Q3 (1 call): drawn on the screen only.'))
  assert.ok(FEATURE.includes('drawn on the screen only'), 'the feature checks the stub words')
})

test('the row limit in the section and in the ui reference is the one of the code', () => {
  const text = SCREEN_LIMIT.toLocaleString('en-US').replace(',', ' ')
  assert.ok(section().includes(text), `the section names ${text}`)
  assert.ok(read('reference/ui.md').includes(text), `reference/ui.md names ${text}`)
})

test('the open questions 50 to 54 exist and the section anchor matches the heading', () => {
  const open = read('open-questions.md')
  for (const n of [50, 51, 52, 53, 54]) assert.ok(open.includes(`| ${n} |`), `open question ${n}`)
  const slug = HEADING.slice(3)
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-')
  assert.equal(slug, 'keeping-track-qa-from-the-model')
  assert.ok(open.includes(`#${slug}`), 'open-questions links the section by its anchor')
})

test('the e2e scenarios that the section cites exist', () => {
  for (const name of [
    'A question and my answer are listed by /track qa, word for word',
    '/track qa --send gives the model the whole text',
  ]) {
    assert.ok(section().includes(name), `the section cites "${name}"`)
    assert.ok(FEATURE.includes(`Scenario: ${name}`), `questions.feature has "${name}"`)
  }
})

test('every relative link of the section resolves, and the cited d.ts block exists', () => {
  const links = [...section().matchAll(/\]\((?!https?:)([^)#]+)(#[^)]*)?\)/g)].map(m => m[1])
  assert.ok(links.length > 3)
  for (const link of links) assert.ok(existsSync(resolve(KB, dirname(PAGE_PATH), link)), `link ${link} resolves`)
  const dts = read('sources/claude-code-2.1.302/types/claude-code.d.ts').split('\n')
  const block = dts.slice(10445, 10455).join('\n')
  assert.ok(block.includes('CommandOutput: {'), 'd.ts 10446-10455 holds CommandOutput')
  assert.ok(block.includes('Raised on every attached surface'), 'd.ts says it is raised on every surface')
})

test('every study id of the evidence table is defined in a spike README, and every E and K id is in the evidence log', () => {
  const s196 = read('sources/spikes-2026-10-26/README.md')
  const s246 = read('sources/spikes-2026-10-27/README.md')
  const log246 = read('sources/spikes-2026-10-27/p246-probe/evidence-log.txt')
  const ids196 = [...section().matchAll(/#196 (S\d+)/g)]
  assert.ok(ids196.length > 5)
  for (const m of ids196) assert.ok(s196.includes(`| ${m[1]} |`), `#196 ${m[1]} is defined`)
  for (const m of section().matchAll(/#246 (S\d+)/g))
    assert.ok(s246.includes(`\`#246 ${m[1]}\``), `#246 ${m[1]} is defined`)
  const cited = new Set([...section().matchAll(/\b([EK]\d+b?)\b/g)].map(m => m[1]))
  assert.ok(cited.size > 3)
  for (const id of cited) assert.ok(new RegExp(`\\b${id}\\b`).test(log246), `${id} is in the #246 evidence log`)
})

/** Every file under `dir`, recursively. */
const files = dir =>
  readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })

test('the probe sources hold no path of a machine', () => {
  const bad = /\/Users\/|\/home\/[a-z]|\/var\/folders\/|\/private\/tmp\//
  for (const d of ['sources/spikes-2026-10-26/p196-probe', 'sources/spikes-2026-10-27'])
    for (const f of files(join(KB, d))) assert.ok(!bad.test(readFileSync(f, 'utf8')), `${f} holds a local path`)
})

test('the sources index lists both probes and each probe folder has its README', () => {
  const index = read('sources/README.md')
  assert.ok(index.includes('p196-probe/') && index.includes('p246-probe/'))
  assert.ok(existsSync(join(KB, 'sources/spikes-2026-10-26/README.md')))
  assert.ok(existsSync(join(KB, 'sources/spikes-2026-10-27/README.md')))
})

test('the KB index and the page header name the issues and the versions of the section', () => {
  const head = PAGE.split('\n').slice(0, 3).join('\n')
  for (const word of ['#71', '#196', '#246', '2.1.312']) assert.ok(head.includes(word), `the header names ${word}`)
  const row = read('README.md')
    .split('\n')
    .find(l => l.includes('[questions-and-plans]'))
  assert.ok(row?.includes('#196') && row.includes('#246'), 'the index row names both issues')
})

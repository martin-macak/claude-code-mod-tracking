import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const scriptPath = path.resolve(import.meta.dirname, '../../.agents/skills/design-study/scripts/score.mjs')
const fixture = {
  feature: '#33 Track background processes',
  items: [
    { id: 'R1', name: 'Background shells', priority: 'Must', verdict: 'Feasible', evidence: 5, ease: 4, safety: 5 },
    { id: 'R2', name: 'Docker containers', priority: 'Must', verdict: 'Feasible', evidence: 5, ease: 3, safety: 4 },
    { id: 'R3', name: 'tmux and screen', priority: 'Should', verdict: 'Partial', evidence: 5, ease: 3, safety: 4 },
    {
      id: 'R4',
      name: 'Detached processes (macOS)',
      priority: 'Should',
      verdict: 'Heuristic',
      evidence: 5,
      ease: 2,
      safety: 3,
    },
    { id: 'R5', name: 'Monitor tasks', priority: 'Could', verdict: 'Untested', evidence: 4, ease: 4, safety: 5 },
  ],
}

test('score.mjs outputs the documented ranking and overall verdict for a file input', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'score-mjs-'))
  const file = path.join(dir, 'items.json')
  writeFileSync(file, JSON.stringify(fixture, null, 2))

  const out = execFileSync(scriptPath, [file], { encoding: 'utf8' })

  assert.match(out, /\*\*#33 Track background processes\*\*/)
  assert.match(out, /\| 1 \| R5 Monitor tasks \| Could \| Untested \| 4 \| 4 \| 5 \| 25 \|/)
  assert.match(
    out,
    /\*\*Overall: Go with caveats\*\* \(mean 55-74\)\. Weighted mean: 69\/100\. Items are ranked weakest first\./,
  )
})

test('score.mjs executes directly from the shebang and accepts stdin input', () => {
  const stdout = execFileSync(scriptPath, { input: JSON.stringify(fixture), encoding: 'utf8' })

  assert.match(stdout, /\*\*Overall: Go with caveats\*\*/)
  assert.match(stdout, /\| 5 \| R1 Background shells \| Must \| Feasible \| 5 \| 4 \| 5 \| 94 \|/)
})

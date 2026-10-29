import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OUT_DIR } from '../support/config.ts'
import { slug } from '../support/slug.ts'

// Issue #185, definition of done 1: two scenario runs on two private sockets run at the same time and both pass. The scenario
// uses a fake model (features/questions.feature), so it needs no login and no real model turn, and anyone can repeat it. It
// starts real tmux sessions and a real `claude`, so `make e2e-pair` runs it (E2E_PAIR=1) and `make e2e-unit` skips it.
const SCENARIO = 'A question and my answer are listed by /track qa, word for word'
const FEATURE = 'features/questions.feature:11'
const have = (cmd: string, flag = '--version') => spawnSync(cmd, [flag]).status === 0
const skip =
  process.env.E2E_PAIR !== '1'
    ? 'set E2E_PAIR=1 (make e2e-pair)'
    : !have('tmux', '-V') || !have('claude')
      ? 'tmux and claude must be on PATH'
      : false

const run = (socket: string, dir: string) =>
  new Promise<{ code: number | null; output: string }>(resolveRun => {
    // No wait for the shared lock: a private run must not need it.
    const child = spawn('npx', ['cucumber-js', '-p', 'one', FEATURE], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DEMO_SOCKET: socket, DEMO_DIR: dir, DEMO_LOCK_WAIT_S: '0' },
    })
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    child.on('close', code => resolveRun({ code, output }))
  })

// First and last mark of the timeline of a run: the window in which its scenario ran.
const windowOf = (socket: string) => {
  const file = join(OUT_DIR, 'private', socket, slug(SCENARIO), 'timeline.ndjson')
  assert.equal(existsSync(file), true, `no timeline at ${file}`)
  const marks = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { t: number }).t)
  return { start: Math.min(...marks), end: Math.max(...marks) }
}

test('two fake-model scenarios on two private sockets run at the same time and both pass', {
  skip,
  timeout: 600_000,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), 'private-pair-'))
  const [a, b] = [`pair-a-${process.pid}`, `pair-b-${process.pid}`]
  try {
    const [ra, rb] = await Promise.all([run(a, join(base, 'a')), run(b, join(base, 'b'))])
    assert.equal(ra.code, 0, ra.output)
    assert.equal(rb.code, 0, rb.output)
    const [wa, wb] = [windowOf(a), windowOf(b)]
    assert.ok(wa.start < wb.end && wb.start < wa.end, `the runs did not overlap: ${JSON.stringify({ wa, wb })}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
    for (const socket of [a, b]) rmSync(join(OUT_DIR, 'private', socket), { recursive: true, force: true })
  }
})

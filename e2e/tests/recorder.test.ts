import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCast } from '../render/cast.ts'
import { findSync } from '../render/retime.ts'
import { stripAnsi } from '../support/ansi.ts'
import { Recorder } from '../support/recorder.ts'
import { Tmux } from '../support/tmux.ts'
import { sleep, waitUntil } from '../support/wait.ts'

const has = (cmd: string) => spawnSync(cmd, ['--version']).status === 0 || spawnSync(cmd, ['-V']).status === 0
const skip = has('tmux') && has('asciinema') ? false : 'tmux or asciinema is not installed'

test('Recorder records tmux with the caption bar into an asciicast v2 file', { skip }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  const tmux = new Tmux(`cc-demo-test-rec-${process.pid}`)
  const recorder = new Recorder()
  t.after(() => tmux.kill())
  tmux.start({ cols: 60, rows: 10, cwd: dir, confDir: dir })
  const castFile = join(dir, 'session.cast')
  await recorder.start(tmux, { castFile, cols: 60, rows: 10 })
  tmux.caption('SYNC-test42')
  tmux.line('echo rec-ok')
  await waitUntil(() => (tmux.capture().includes('rec-ok') ? true : undefined), { timeoutMs: 5000, what: 'rec-ok' })
  tmux.caption('PR #16 #[x]')
  await sleep(300)
  await recorder.stop(tmux)

  const cast = parseCast(readFileSync(castFile, 'utf8'))
  assert.equal(cast.header.width, 60)
  assert.equal(cast.header.height, 11)
  assert.equal(typeof findSync(cast, 'SYNC-test42'), 'number')
  const text = cast.events.map(e => stripAnsi(e[2])).join('')
  assert.match(text, /rec-ok/)
  assert.match(text, /PR #16 #\[x\]/)
})

test('Recorder fails fast and stops at once when the recorder binary is missing', {
  skip: has('tmux') ? false : 'tmux is not installed',
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-missing-'))
  const tmux = new Tmux(`cc-demo-test-rec-missing-${process.pid}`)
  t.after(() => tmux.kill())
  tmux.start({ cols: 40, rows: 5, cwd: dir, confDir: dir })
  const recorder = new Recorder('cc-demo-no-such-recorder')
  await assert.rejects(recorder.start(tmux, { castFile: join(dir, 'x.cast'), cols: 40, rows: 5 }), /failed to start/)
  const started = Date.now()
  await recorder.stop(tmux)
  assert.ok(Date.now() - started < 1000, 'stop must not wait for a process that never ran')
})

test('Recorder stop is a no-op before start', async () => {
  await new Recorder().stop(new Tmux('cc-demo-test-unused'))
})

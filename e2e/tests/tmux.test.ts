import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { focusedTexts } from '../support/pane.ts'
import { Tmux, tmuxLiteral } from '../support/tmux.ts'
import { waitUntil } from '../support/wait.ts'

const skip = spawnSync('tmux', ['-V']).status === 0 ? false : 'tmux is not installed'

async function shell(name: string): Promise<Tmux> {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-'))
  const tmux = new Tmux(`cc-demo-test-${name}-${process.pid}`)
  tmux.start({ cols: 80, rows: 20, cwd: dir, confDir: dir })
  // capture-pane trims trailing spaces, so the prompt "$ " reads as "$".
  await waitUntil(() => (/^\$/m.test(tmux.capture()) ? true : undefined), { timeoutMs: 5000, what: 'shell prompt' })
  return tmux
}

const screenHas = (tmux: Tmux, text: string) =>
  waitUntil(() => (tmux.capture().includes(text) ? true : undefined), {
    timeoutMs: 5000,
    what: text,
    last: () => tmux.capture(),
  })

test('tmuxLiteral escapes a trailing ";" only', () => {
  assert.equal(tmuxLiteral('a;'), 'a\\;')
  assert.equal(tmuxLiteral(';'), '\\;')
  assert.equal(tmuxLiteral('a;b'), 'a;b')
})

test('Tmux types literal text, including ";" and "-"', { skip }, async t => {
  const tmux = await shell('type')
  t.after(() => tmux.kill())
  await tmux.type('echo a;b - "#c" é', 1)
  await screenHas(tmux, 'echo a;b - "#c" é')
})

test('Tmux runs a line and shows its output', { skip }, async t => {
  const tmux = await shell('line')
  t.after(() => tmux.kill())
  tmux.line('echo hello-$((40+2))')
  await screenHas(tmux, 'hello-42')
})

test('Tmux respawn runs a command in the pane without echoing the command line', { skip }, async t => {
  const tmux = await shell('respawn')
  t.after(() => tmux.kill())
  tmux.respawn('echo hidden-$((1+1)); sleep 5')
  await screenHas(tmux, 'hidden-2')
  assert.equal(tmux.capture().includes('echo hidden'), false)
})

test('Tmux captureAnsi keeps the reverse video that capture drops', { skip }, async t => {
  const tmux = await shell('ansi')
  t.after(() => tmux.kill())
  tmux.respawn("printf '\\033[7minv\\033[0m plain\\n'; sleep 5")
  await screenHas(tmux, 'inv plain')
  assert.equal(tmux.capture().includes('\u001b'), false)
  assert.deepEqual(focusedTexts(tmux.captureAnsi()), ['inv'])
})

test('Tmux stores the caption and escapes "#["', { skip }, async t => {
  const tmux = await shell('caption')
  t.after(() => tmux.kill())
  tmux.caption('PR #16 #[x]')
  assert.equal(tmux.captionValue(), 'PR #16 ##[x]')
})

test('Tmux kill never throws, also twice', { skip }, async () => {
  const tmux = await shell('kill')
  tmux.kill()
  tmux.kill()
})

test('Tmux click sends an SGR mouse press and release at the 1-based column and row', { skip }, async t => {
  const tmux = await shell('click')
  t.after(() => tmux.kill())
  tmux.line('cat -v') // cat shows the escape bytes as ^[
  tmux.click(30, 5)
  await screenHas(tmux, '^[[<0;30;5M^[[<0;30;5m')
})

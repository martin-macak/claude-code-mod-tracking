import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copiedText, probeSource, writeCopyProbe } from '../support/copy-probe.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'copy-probe-'))

test('the probe plugin has a manifest, a hooks file that names its module, and the module', () => {
  const dir = tempDir()
  const probe = writeCopyProbe(dir)
  assert.equal(probe.pluginDir, join(dir, 'plugin'))
  const manifest = JSON.parse(readFileSync(join(probe.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'copy-probe')
  assert.deepEqual(JSON.parse(readFileSync(join(probe.pluginDir, 'hooks', 'hooks.json'), 'utf8')), {
    modules: ['./register.ts'],
  })
  assert.equal(readFileSync(join(probe.pluginDir, 'hooks', 'register.ts'), 'utf8'), probeSource(probe.logFile))
})

test('the log lies beside the plugin folder, which the engine watches, and not in it', () => {
  const dir = tempDir()
  const probe = writeCopyProbe(dir)
  assert.equal(probe.logFile, join(dir, 'copy.log'))
  assert.ok(!probe.logFile.startsWith(`${probe.pluginDir}/`))
})

test('the module answers ui.copy without next, so the engine never writes the clipboard, and it logs the text', () => {
  const source = probeSource('/tmp/a b/copy.log')
  assert.match(source, /on\('ui\.copy'/)
  assert.match(source, /return \{ value: \{ isCopied: true \} \}/)
  assert.doesNotMatch(source, /next/)
  assert.ok(source.includes(JSON.stringify('/tmp/a b/copy.log')))
})

test('copiedText reads the JSON text of the log and is undefined while the log is missing, empty or no file', () => {
  const dir = tempDir()
  const log = join(dir, 'copy.log')
  assert.equal(copiedText(log), undefined)
  writeFileSync(log, '')
  assert.equal(copiedText(log), undefined)
  writeFileSync(log, `${JSON.stringify('## Q1 · turn 1\n- [x] State only')}\n`)
  assert.equal(copiedText(log), '## Q1 · turn 1\n- [x] State only')
  mkdirSync(join(dir, 'x'))
  assert.equal(copiedText(join(dir, 'x')), undefined)
})

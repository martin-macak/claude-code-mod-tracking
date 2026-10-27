import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeProbePlugin } from '../support/probe-plugin.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'probe-plugin-'))

test('a probe plugin has a manifest, a hooks file that names its module, and the module made from the log path', () => {
  const dir = tempDir()
  const probe = writeProbePlugin(dir, {
    name: 'some-probe',
    description: 'e2e probe: does a thing',
    logName: 'some.log',
    source: logFile => `// module that logs to ${logFile}\n`,
  })
  assert.equal(probe.pluginDir, join(dir, 'plugin'))
  assert.equal(probe.logFile, join(dir, 'some.log'))
  assert.deepEqual(JSON.parse(readFileSync(join(probe.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')), {
    name: 'some-probe',
    version: '0.0.1',
    description: 'e2e probe: does a thing',
    author: { name: 'e2e' },
  })
  assert.deepEqual(JSON.parse(readFileSync(join(probe.pluginDir, 'hooks', 'hooks.json'), 'utf8')), {
    modules: ['./register.ts'],
  })
  assert.equal(
    readFileSync(join(probe.pluginDir, 'hooks', 'register.ts'), 'utf8'),
    `// module that logs to ${join(dir, 'some.log')}\n`,
  )
})

test('the log lies beside the plugin folder, which the engine watches, and not in it', () => {
  const dir = tempDir()
  const probe = writeProbePlugin(dir, { name: 'p', description: 'd', logName: 'x.log', source: () => '' })
  assert.ok(!probe.logFile.startsWith(`${probe.pluginDir}/`))
})

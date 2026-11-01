import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TURN_END_MARK, turnEndSource, writeTurnEndProbe } from '../support/turn-end-probe.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'turn-end-probe-'))

test('the probe plugin has a manifest, a hooks file that names its module, and the module', () => {
  const probe = writeTurnEndProbe(tempDir())
  const manifest = JSON.parse(readFileSync(join(probe.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'turn-end-probe')
  assert.deepEqual(JSON.parse(readFileSync(join(probe.pluginDir, 'hooks', 'hooks.json'), 'utf8')), {
    modules: ['./register.ts'],
  })
  assert.equal(readFileSync(join(probe.pluginDir, 'hooks', 'register.ts'), 'utf8'), turnEndSource())
})

// Runs the module on a fake engine: the hook of `turn.complete` with a chain that gives `below`.
type Result = { text?: string; other?: number }
type Hook = (...args: unknown[]) => Promise<Result>

async function load(): Promise<Hook> {
  const file = join(writeTurnEndProbe(tempDir()).pluginDir, 'hooks', 'register.ts')
  const { register } = (await import(`${file}?${Date.now()}-${Math.random()}`)) as {
    register: (on: (name: string, hook: (...args: never[]) => unknown) => void) => void
  }
  let hook: Hook | undefined
  register((name, h) => {
    assert.equal(name, 'turn.complete')
    hook = h as typeof hook
  })
  assert.ok(hook, 'the module registers a turn.complete hook')
  return hook
}

async function run(event: { agentId?: string; answer: string }, below: Record<string, unknown>): Promise<Result> {
  return (await load())({}, event, async () => below)
}

test('a main turn end that no other hook noticed gets the mark alone', async () => {
  assert.equal((await run({ answer: 'ok' }, { text: 'ok' })).text, TURN_END_MARK)
  assert.equal((await run({ answer: 'ok' }, {})).text, TURN_END_MARK)
})

test('the notice of another plugin stays and the mark follows it on a new line, so both are one row', async () => {
  assert.equal(
    (await run({ answer: 'ok' }, { text: '+2 new · /track turn 1' })).text,
    `+2 new · /track turn 1\n${TURN_END_MARK}`,
  )
})

test('the end of a subagent turn gets no mark', async () => {
  assert.deepEqual(await run({ agentId: 'a1', answer: 'ok' }, { text: 'ok' }), { text: 'ok' })
})

test('a chain text that is no string or is empty gives the mark alone', async () => {
  assert.equal((await run({ answer: 'ok' }, { text: 42 })).text, TURN_END_MARK)
  assert.equal((await run({ answer: 'ok' }, { text: '' })).text, TURN_END_MARK)
})

test('the other fields of the chain result are kept', async () => {
  assert.equal((await run({ answer: 'ok' }, { text: 'x', other: 1 })).other, 1)
})

// Issue #197: the mark must not come back before a slow line. The mod draws its line only through the text that its hook
// returns, and the probe puts the mark into that same string, so a slow line delays the mark and the mark cannot show without it.
test('the mark does not come back before a slow line of the hook beneath', async () => {
  const hook = await load()
  const line = '+2 new · /track turn 1'
  let settled = false
  const done = hook({}, { answer: 'ok' }, async () => {
    await new Promise(r => setTimeout(r, 300))
    return { text: line }
  }).then(r => {
    settled = true
    return r
  })
  await new Promise(r => setTimeout(r, 100))
  assert.equal(settled, false, 'the probe waits for the chain')
  assert.equal((await done).text, `${line}\n${TURN_END_MARK}`)
})

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CONFIG_FILE, makeConfigDir, pathWidthRefusal } from '../support/config-dir.ts'

const base = mkdtempSync(join(tmpdir(), 'config-dir-'))
after(() => rmSync(base, { recursive: true, force: true }))

const width = (dir: string) => join(dir, CONFIG_FILE).length

test('makeConfigDir makes an empty folder under the base', () => {
  const dir = makeConfigDir(base)
  assert.equal(dir.startsWith(join(base, 'cc-tracker-config-')), true)
  assert.deepEqual(readdirSync(dir), [])
})

test('makeConfigDir gives the config file the path width that is asked for', () => {
  const plain = width(makeConfigDir(base))
  for (const cells of [plain, plain + 1, plain + 30]) {
    const dir = makeConfigDir(base, cells)
    assert.equal(width(dir), cells)
    assert.deepEqual(readdirSync(dir), [], `the folder for ${cells} cells is empty`)
  }
})

test('makeConfigDir refuses a width that the base folder passes already, and makes no folder', () => {
  const plain = width(makeConfigDir(base))
  const made = readdirSync(base)
  assert.throws(() => makeConfigDir(base, plain - 1), /already.*TMPDIR/s)
  assert.deepEqual(readdirSync(base), made)
})

test('the path width is set before the session starts and before the config file is written', () => {
  assert.equal(pathWidthRefusal({ launched: false, written: false }), undefined)
  assert.match(pathWidthRefusal({ launched: true, written: false }) ?? '', /before the step that starts the session/)
  assert.match(
    pathWidthRefusal({ launched: false, written: true }) ?? '',
    /before the step that writes the config file/,
  )
})

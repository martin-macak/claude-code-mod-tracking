import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import {
  assertStampUnchanged,
  CLIPBOARD_TOOLS,
  capturedBy,
  clipboardGuardEnv,
  clipboardRoutes,
  NO_ADDON,
  pasteboardStamp,
  shimSource,
  withClipboardGuard,
  writeClipboardGuard,
} from '../support/clipboard-guard.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'clipboard-guard-'))

test('the guard writes one executable shim for each clipboard tool the engine may start', () => {
  const guard = writeClipboardGuard(tempDir())
  assert.deepEqual([...CLIPBOARD_TOOLS].sort(), ['pbcopy', 'wl-copy', 'xclip', 'xsel'])
  for (const tool of CLIPBOARD_TOOLS) {
    assert.ok((statSync(join(guard.binDir, tool)).mode & 0o111) !== 0, `${tool} is executable`)
  }
})

test('a shim keeps its input and writes no clipboard', () => {
  // The shim runs only `cat > file` and `exit 0`: no line starts a clipboard tool.
  const body = shimSource('pbcopy', '/tmp/x')
    .split('\n')
    .filter(l => l !== '' && !l.startsWith('#'))
  assert.deepEqual(body, ['cat > "/tmp/x/pbcopy"', 'exit 0'])
  const guard = writeClipboardGuard(tempDir())
  assert.equal(capturedBy(guard, 'pbcopy'), undefined)
  execFileSync(join(guard.binDir, 'pbcopy'), ['-x'], { input: 'Q1 · turn 1\n- [x] **A**' })
  assert.equal(capturedBy(guard, 'pbcopy'), 'Q1 · turn 1\n- [x] **A**')
  assert.equal(capturedBy(guard, 'xclip'), undefined)
})

test('the environment puts the shims first on the PATH and points the native addon at nothing', () => {
  const guard = writeClipboardGuard(tempDir())
  const env = clipboardGuardEnv(guard, '/usr/bin:/bin')
  assert.equal(env.PATH, `${guard.binDir}${delimiter}/usr/bin:/bin`)
  assert.equal(env.CLIPBOARD_NAPI_NODE_PATH, NO_ADDON)
  assert.equal(clipboardGuardEnv(guard, '').PATH, guard.binDir)
})

test('the guard merges into an environment and keeps the PATH of the fake gh behind the shims', () => {
  const guard = writeClipboardGuard(tempDir())
  const env = withClipboardGuard(guard, { PATH: '/fake/gh/bin:/usr/bin', GH_X: '1' })
  assert.equal(env.PATH, `${guard.binDir}${delimiter}/fake/gh/bin:/usr/bin`)
  assert.equal(env.GH_X, '1')
  assert.equal(env.CLIPBOARD_NAPI_NODE_PATH, NO_ADDON)
})

test('the pasteboard stamp is a number on macOS, undefined off macOS, and a failed macOS read throws', () => {
  const exec = () => '549\n'
  assert.equal(pasteboardStamp(exec, 'darwin'), 549)
  assert.equal(pasteboardStamp(exec, 'linux'), undefined)
  assert.throws(() => pasteboardStamp(() => 'nope', 'darwin'), /pasteboard counter/)
  assert.throws(
    () =>
      pasteboardStamp(() => {
        throw new Error('no osascript')
      }, 'darwin'),
    /pasteboard counter/,
  )
})

test('a moved pasteboard stamp fails the check, an equal one passes, one counter that cannot be read fails', () => {
  assert.throws(() => assertStampUnchanged(549, 550), /changeCount moved from 549 to 550/)
  assertStampUnchanged(549, 549)
  assertStampUnchanged(undefined, undefined)
  assert.throws(() => assertStampUnchanged(549, undefined), /could not be read/)
  assert.throws(() => assertStampUnchanged(undefined, 549), /could not be read/)
})

test('the routes of a copy name the tools that got text, and fail when no route did', () => {
  const guard = writeClipboardGuard(tempDir())
  assert.throws(() => clipboardRoutes(guard, undefined), /no route took the copy/)
  assert.equal(clipboardRoutes(guard, 'text')['tmux-buffer'], true)
  execFileSync(join(guard.binDir, 'xclip'), [], { input: 'x' })
  const routes = clipboardRoutes(guard, undefined)
  assert.equal(routes.xclip, true)
  assert.equal(routes.pbcopy, false)
})

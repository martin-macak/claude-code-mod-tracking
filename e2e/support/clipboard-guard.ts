import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// A guard for the copy key of the questions tracker (issue #207, features/questions.feature). The key hands the call to
// the engine with `$.ui.copy`. With no probe in the way, the engine writes the text through up to four routes: the tmux
// buffer (`tmux load-buffer`), an OSC 52 sequence, a clipboard tool (`pbcopy`, `xclip`, `wl-copy`) and a native addon.
// This guard keeps the clipboard of the person out of the run and still lets the engine take its routes:
// - the tmux buffer of the private socket is real and a step reads it with `tmux show-buffer`;
// - the clipboard tools are shims on the PATH of the session that keep their input in a file and write nothing else;
// - the native addon is pointed at a file that does not exist, so it cannot load (Claude Code 2.1.316: the loader returns null
//   before it reads the variable, so the addon never loads there; macOS writes only through `pbcopy`, `tmux load-buffer -w`
//   and OSC 52);
// - on macOS a counter of the pasteboard (never its content) is read before and after the run, so a write that bypasses the
//   shims (an absolute `/usr/bin/pbcopy`, a client attached to the tmux server) fails the scenario.

/** The tools the engine may start to write a clipboard. */
export const CLIPBOARD_TOOLS: readonly string[] = ['pbcopy', 'xclip', 'xsel', 'wl-copy']

/** A path that holds no addon: the engine falls through to the next route. */
export const NO_ADDON = '/nonexistent/clipboard-napi.node'

export type ClipboardGuard = {
  /** The folder that goes first on the PATH of the session. */
  readonly binDir: string
  /** The folder that holds what each shim got on its input, in a file named like the tool. */
  readonly captureDir: string
}

/** The text of a shim: keeps the input in `<captureDir>/<tool>` (the last call wins). */
export function shimSource(tool: string, captureDir: string): string {
  const out = JSON.stringify(join(captureDir, tool))
  return [
    '#!/bin/sh',
    '# Test shim of the e2e harness: keeps what the engine would put on the clipboard, and writes no clipboard.',
    `cat > ${out}`,
    'exit 0',
    '',
  ].join('\n')
}

/** Writes the shims into `dir`. */
export function writeClipboardGuard(dir: string): ClipboardGuard {
  const binDir = join(dir, 'bin')
  const captureDir = join(dir, 'captured')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(captureDir, { recursive: true })
  for (const tool of CLIPBOARD_TOOLS) {
    const file = join(binDir, tool)
    writeFileSync(file, shimSource(tool, captureDir))
    chmodSync(file, 0o755)
  }
  return { binDir, captureDir }
}

/** The variables of the session. `env(1)` sets them for claude only. */
export function clipboardGuardEnv(
  guard: ClipboardGuard,
  basePath: string = process.env.PATH ?? '',
): Record<string, string> {
  return {
    PATH: [guard.binDir, ...(basePath === '' ? [] : [basePath])].join(delimiter),
    CLIPBOARD_NAPI_NODE_PATH: NO_ADDON,
  }
}

/** What a tool shim got on its input, or undefined while it was not called. */
export function capturedBy(guard: ClipboardGuard, tool: string): string | undefined {
  try {
    return readFileSync(join(guard.captureDir, tool), 'utf8')
  } catch {
    return undefined
  }
}

/** Merges the guard into the environment of the session: the shim folder goes first, before any PATH already in `env`. */
export function withClipboardGuard(guard: ClipboardGuard, env: Record<string, string>): Record<string, string> {
  return { ...env, ...clipboardGuardEnv(guard, env.PATH ?? process.env.PATH) }
}

/** Runs a command and returns its output. Injected in tests. */
export type Exec = (file: string, args: string[]) => string

const defaultExec: Exec = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 5000 })

/**
 * The change counter of the system pasteboard (macOS), or undefined where the platform has none. A counter moves with every
 * write and holds no content, so reading it never touches the clipboard of the person. On macOS a failed read throws: a check
 * that cannot read the counter must not pass.
 */
export function pasteboardStamp(exec: Exec = defaultExec, platform: string = process.platform): number | undefined {
  if (platform !== 'darwin') return undefined
  let out: string
  try {
    out = exec('osascript', [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount',
    ])
  } catch (error) {
    throw new Error(`the pasteboard counter could not be read: ${error instanceof Error ? error.message : error}`)
  }
  const n = Number(out.trim())
  if (!Number.isInteger(n))
    throw new Error(`the pasteboard counter could not be read: unexpected output ${JSON.stringify(out)}`)
  return n
}

/**
 * Throws when the pasteboard counter moved, or when only one of the two reads worked (the check cannot prove the clipboard is
 * unchanged). Both undefined: the platform has no counter (a failed macOS read throws in `pasteboardStamp`), and nothing is checked.
 */
export function assertStampUnchanged(before: number | undefined, after: number | undefined): void {
  if (before === undefined && after === undefined) return
  if (before === undefined || after === undefined)
    throw new Error(
      `the pasteboard counter could not be read ${before === undefined ? 'before' : 'after'} the run: the clipboard of this machine is unverified`,
    )
  if (before !== after) {
    throw new Error(
      `the clipboard of this machine changed: pasteboard changeCount moved from ${before} to ${after} (did you copy during the run?)`,
    )
  }
}

/** The routes that took the copy: the tmux buffer and each clipboard tool the engine started. Throws when none did. */
export function clipboardRoutes(guard: ClipboardGuard, buffer: string | undefined): Record<string, boolean> {
  const routes = {
    'tmux-buffer': buffer !== undefined,
    ...Object.fromEntries(CLIPBOARD_TOOLS.map(tool => [tool, capturedBy(guard, tool) !== undefined])),
  }
  if (!Object.values(routes).some(Boolean))
    throw new Error('no route took the copy: the tmux buffer and every clipboard tool are empty')
  return routes
}

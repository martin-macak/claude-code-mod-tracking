import { statSync } from 'node:fs'

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export type WaitOptions = { timeoutMs: number; intervalMs?: number; what: string; last?: () => string }

// Polls until probe returns a value. The error names what it waited for and shows the last screen.
export async function waitUntil<T>(probe: () => T | undefined, opts: WaitOptions): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      const screen = opts.last ? `\n--- last screen ---\n${opts.last()}` : ''
      throw new Error(`timed out after ${opts.timeoutMs} ms waiting for ${opts.what}${screen}`)
    }
    await sleep(opts.intervalMs ?? 200)
  }
}

// How long ago the file last changed, in ms, or undefined when there is no such file. A wait for a quiet log counts from the
// last change, so a slow machine that writes the log late only makes the wait longer, as the event it waits for says.
export function idleMs(file: string, now: number = Date.now()): number | undefined {
  try {
    return Math.max(0, now - statSync(file).mtimeMs)
  } catch {
    return undefined
  }
}

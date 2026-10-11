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

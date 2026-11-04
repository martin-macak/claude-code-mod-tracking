// A sleep that a test can park. After `hold()`, the next call parks until `resume()`: the caller is in a sleep then, and in no
// try at the lock. A test that lets go of a lock that a waiting claim waits for does it while the claim is parked. A claim that
// is in the middle of a try could take the lock in that instant, and then it would not poll again (issue #343).
// `whenParked` resolves when a call has parked. A second `hold()` before `resume()` changes nothing.
export function parkableSleep(options: { onParked?: () => void } = {}) {
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  let parked: () => void = () => {}
  let whenParked = new Promise<void>(() => {})
  const arm = () => {
    whenParked = new Promise<void>(resolve => {
      parked = resolve
    })
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  }
  return {
    // The sleep itself. It waits on the real clock for `ms`, after the park (if one is armed).
    async sleep(ms: number) {
      if (gate !== undefined) {
        const waiting = gate
        parked()
        options.onParked?.()
        await waiting
      }
      await new Promise(resolve => setTimeout(resolve, ms))
    },
    hold() {
      if (gate === undefined) arm()
    },
    resume() {
      release?.()
      gate = undefined
      release = undefined
    },
    // The promise of the park that the last `hold()` armed.
    get whenParked() {
      return whenParked
    },
  }
}

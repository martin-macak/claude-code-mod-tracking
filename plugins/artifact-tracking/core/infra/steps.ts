// Steps: how the lifecycle runs a step that may fail. A failure is logged as one line and the caller goes on.
// `guard` is for a step of a switch or an entry, `soft` for a step of the start sequence, which has a fallback value.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 6 (error handling). Plan: L3 Tasks 5 to 8.

export const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Runs a step. A failure is logged as `lifecycle: <what> failed in <where>: <message>`. Never rejects. */
export async function guard(
  log: (line: string) => void,
  what: string,
  step: () => Promise<unknown>,
  where = 'a switch',
): Promise<void> {
  try {
    await step()
  } catch (e) {
    log(`lifecycle: ${what} failed in ${where}: ${reason(e)}`)
  }
}

/** A step of the start sequence: a failure is logged and the fallback stands in, so the start always completes. */
export async function soft<T>(
  log: (line: string) => void,
  what: string,
  step: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await step()
  } catch (e) {
    log(`lifecycle: ${what} failed in the start: ${reason(e)}`)
    return fallback
  }
}

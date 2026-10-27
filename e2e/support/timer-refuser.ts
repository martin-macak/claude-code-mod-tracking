import { readFileSync } from 'node:fs'
import { type ProbePlugin, writeProbePlugin } from './probe-plugin.ts'

// A probe plugin that refuses an engine timer (issue #193, features/pane.feature). A hook of a plugin can deny the dispatch
// of `$.clock.after`: the timer never fires and the caller hears nothing. The probe denies the `clock.after` of one delay
// and passes every other, with `next`, so the timers of the mod keep working. It counts what it refused in a log beside its
// folder, so a scenario can prove the refusal took place and did not pass by luck. The folder of a plugin is watched, so
// the log never lies in it.

/** The files of the probe in a folder: the plugin and, beside it, the log. `ms` is the delay it refuses. */
export type TimerRefuser = ProbePlugin & { readonly ms: number }

/**
 * The module of the probe. The delay and the log path are in the text, so the probe reads no environment. It refuses `ms`
 * and no other delay: a delay shared with a timer of the mod would drop that timer too (1000 ms is also the default of
 * `refresh.captureDebounceMs`). The log holds the number of refusals so far, as one line.
 */
export function refuserSource(ms: number, logFile: string): string {
  return [
    `// Test probe of the e2e harness: denies clock.after of ${ms} ms and passes every other delay.`,
    'let refused = 0',
    'export const register = on => {',
    "  on('clock.after', async ($, e, next) => {",
    `    if (e.ms !== ${ms}) return next(e)`,
    '    refused += 1',
    `    await $.fs.write(${JSON.stringify(logFile)}, \`\${refused}\\n\`)`,
    `    return { deny: 'e2e timer refuser: clock.after of ${ms} ms' }`,
    '  })',
    '}',
    '',
  ].join('\n')
}

/** Writes the probe plugin into `dir`, and says where its log will be. The log does not exist until the probe refuses. */
export function writeTimerRefuser(dir: string, ms: number): TimerRefuser {
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`timer refuser: the delay must be a whole number of ms: ${ms}`)
  const probe = writeProbePlugin(dir, {
    name: 'timer-refuser',
    description: `e2e probe: refuses clock.after of ${ms} ms`,
    logName: 'refused.log',
    source: logFile => refuserSource(ms, logFile),
  })
  return { ...probe, ms }
}

/**
 * Why a step may not install a refuser of `ms` when a scenario already has `existing`, or undefined when it may. One
 * scenario has one refuser. A second step with the same delay changes nothing. A second step with another delay would be
 * dropped, and the scenario would refuse another timer than the one it names.
 */
export function timerRefuserRefusal(existing: TimerRefuser | undefined, ms: number): string | undefined {
  if (existing === undefined || existing.ms === ms) return undefined
  return `timer refuser: already set to ${existing.ms} ms, cannot also refuse ${ms} ms`
}

/** How many timers the probe refused so far: 0 while its log is missing or empty. */
export function refusals(logFile: string): number {
  let raw: string
  try {
    raw = readFileSync(logFile, 'utf8')
  } catch {
    return 0
  }
  const count = Number(raw.trim())
  return Number.isInteger(count) ? count : 0
}

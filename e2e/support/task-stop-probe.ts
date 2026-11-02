import { readFileSync } from 'node:fs'
import { type ProbePlugin, writeProbePlugin } from './probe-plugin.ts'

// A probe plugin for issue #209 (features/clean-tasks.feature). It hears every `tool.call` of TaskStop as a plugin of its own and
// writes `tool_use_id`, `next.origin` and the answer of the call to a log, one JSON line per call, so a scenario can read what the engine
// gives for a TaskStop that `/track clean --yes tasks` raised. It passes the call on with `next`, so the stop still runs.
// The folder of a plugin is watched, so the log lies beside it, never in it.

/** The files of the probe in a folder: the plugin and, beside it, the log. */
export type TaskStopProbe = ProbePlugin

/** The module of the probe. The log path is in the text, so the probe reads no environment. */
export function taskStopProbeSource(logFile: string): string {
  return [
    '// Test probe of the e2e harness: logs tool_use_id and next.origin of each TaskStop call, then passes the answer on.',
    'const seen = []',
    'export const register = on => {',
    "  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {",
    '    const out = await next(e)',
    '    seen.push(JSON.stringify({ tool_use_id: e.tool_use_id ?? null, origin: next.origin ?? null, task_id: e.task_id ?? null, result: out?.result ?? null }))',
    `    await $.fs.write(${JSON.stringify(logFile)}, \`\${seen.join('\\n')}\\n\`)`,
    '    return out',
    '  })',
    '}',
    '',
  ].join('\n')
}

/** Writes the probe plugin into `dir`, and says where its log will be. The log does not exist until the probe hears a call. */
export function writeTaskStopProbe(dir: string): TaskStopProbe {
  return writeProbePlugin(dir, {
    name: 'task-stop-probe',
    description: 'e2e probe: logs the origin of TaskStop calls',
    logName: 'task-stop.log',
    source: taskStopProbeSource,
  })
}

/** The lines the probe wrote so far: empty while its log is missing. */
export function taskStopLines(logFile: string): string[] {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(l => l !== '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

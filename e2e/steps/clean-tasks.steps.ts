import { execFileSync } from 'node:child_process'
import { Given, Then } from '@cucumber/cucumber'
import { taskStopLines } from '../support/task-stop-probe.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// Issue #209. Steps for the live check of `/track clean --yes tasks`. The model is a script (the fake Messages API); the engine,
// the tools, the hooks and the stop are the real ones. A task is started by the scenario, so it is the only thing it may stop.

// Before the session step. The mode of the machine can be anything, so the scenario names the mode it checks.
Given('the session runs in auto permission mode', function (this: DemoWorld) {
  this.setPermissionMode('auto')
})

// The model starts one background Bash task in its only prompt. The session needs the tool: `and the tools "Bash"`.
Given('a fake model that starts the background task {string}', async function (this: DemoWorld, command: string) {
  await this.startFakeApi([
    [
      { type: 'text', text: 'I will start it.' },
      { type: 'tool_use', id: 'toolu_e2e_bg', name: 'Bash', input: { command, run_in_background: true } },
    ],
    [{ type: 'text', text: 'Started.' }],
  ])
})

// The model starts one Monitor on a command in its only prompt. The session needs the tool: `and the tools "Monitor"`.
Given('a fake model that starts a Monitor on {string}', async function (this: DemoWorld, command: string) {
  await this.startFakeApi([
    [
      { type: 'text', text: 'I will watch it.' },
      {
        type: 'tool_use',
        id: 'toolu_e2e_monitor',
        name: 'Monitor',
        input: { description: 'e2e monitor', command, timeout_ms: 600000 },
      },
    ],
    [{ type: 'text', text: 'Watching.' }],
  ])
})

// Before the session step.
Given('a plugin that logs the origin of TaskStop calls', function (this: DemoWorld) {
  this.installTaskStopProbe()
})

/** True when a process runs a command line that is exactly `command`. The scenario reads the table of processes and kills none. */
function processRuns(command: string): boolean {
  const table = execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8' })
  return table.split('\n').some(line => line.trim() === command)
}

Then('the process {string} is running', async function (this: DemoWorld, command: string) {
  await waitUntil(() => (processRuns(command) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the process "${command}" to run`,
    last: () => 'not in the table of processes',
  })
})

Then('the process {string} is gone', async function (this: DemoWorld, command: string) {
  await waitUntil(() => (processRuns(command) ? undefined : true), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the process "${command}" to be gone`,
    last: () => 'still in the table of processes',
  })
})

// Waits for the line of the probe that holds the text, and keeps the line for the steps after it.
Then('the TaskStop log holds {string}', async function (this: DemoWorld, text: string) {
  const probe = probeOf(this, 'the TaskStop log holds')
  await waitUntil(() => (taskStopLines(probe.logFile).some(l => l.includes(text)) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the TaskStop log to hold "${text}"`,
    last: () => JSON.stringify(taskStopLines(probe.logFile)),
  })
})

/** The probe of the scenario, or an error naming the step that needs it. */
function probeOf(world: DemoWorld, step: string) {
  const probe = world.taskStopProbe
  if (probe === undefined) throw new Error(`${step}: no probe in this scenario`)
  return probe
}

// Waits until the log has at least that many lines (the probe writes after `next` returns, so the screen can be ahead of it), then
// asserts the count is exact, so a second TaskStop fails the scenario. It prints the log to the report of the run.
Then('the TaskStop log has {int} line(s)', async function (this: DemoWorld, count: number) {
  const probe = probeOf(this, 'the TaskStop log has')
  await waitUntil(() => (taskStopLines(probe.logFile).length >= count ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the TaskStop log to have ${count} line(s)`,
    last: () => JSON.stringify(taskStopLines(probe.logFile)),
  })
  const lines = taskStopLines(probe.logFile)
  console.log(`TaskStop log: ${JSON.stringify(lines)}`)
  if (lines.length !== count)
    throw new Error(`the TaskStop log has ${lines.length} lines, not ${count}: ${JSON.stringify(lines)}`)
})

/** The parsed line `n` (1-based) of the log, or undefined while it is missing. A line that is not JSON is an error. */
function logEntry(logFile: string, n: number): Record<string, unknown> | undefined {
  const line = taskStopLines(logFile)[n - 1]
  return line === undefined ? undefined : (JSON.parse(line) as Record<string, unknown>)
}

// The origin the engine gave the call: `artifact-tracking` for a call the mod raised, `engine` for the call of the model.
Then(
  'the TaskStop log line {int} has origin plugin {string}',
  async function (this: DemoWorld, n: number, plugin: string) {
    const probe = probeOf(this, 'the TaskStop log line')
    const entry = await waitUntil(() => logEntry(probe.logFile, n), {
      timeoutMs: this.config.screenTimeoutMs,
      what: `line ${n} of the TaskStop log`,
      last: () => JSON.stringify(taskStopLines(probe.logFile)),
    })
    const origin = entry.origin as { plugin?: unknown } | null
    if (origin?.plugin !== plugin)
      throw new Error(
        `TaskStop log line ${n}: origin.plugin is ${JSON.stringify(origin?.plugin)}, not "${plugin}": ${JSON.stringify(entry)}`,
      )
  },
)

Then(
  'the TaskStop log line {int} has a tool_use_id that starts with {string}',
  async function (this: DemoWorld, n: number, prefix: string) {
    const probe = probeOf(this, 'the TaskStop log line')
    const entry = await waitUntil(() => logEntry(probe.logFile, n), {
      timeoutMs: this.config.screenTimeoutMs,
      what: `line ${n} of the TaskStop log`,
      last: () => JSON.stringify(taskStopLines(probe.logFile)),
    })
    if (typeof entry.tool_use_id !== 'string' || !entry.tool_use_id.startsWith(prefix))
      throw new Error(
        `TaskStop log line ${n}: tool_use_id is ${JSON.stringify(entry.tool_use_id)}, not "${prefix}...": ${JSON.stringify(entry)}`,
      )
  },
)

// `/track clean` for processes: the cleanup of the processes tracker. It has two kinds.
//
// `tasks` (issue #122): the plan lists each running background Bash task for a TaskStop. `--yes tasks` stops them one by one
// through the narrow `tasks.stop` port and marks the row `killed` itself: the mod's own `tool.call` hook hears the call too, as a
// call that a plugin raised (design study of #204, S2: kit-verified, not yet seen live, #209), so it stamps no turn, and the two
// writes are the same (the first end time stays). A Monitor task is listed and skipped: its stop is not tested (design study of
// #49, R11b). tmux, screen and detached processes are not touched: the study found no proof of who owns them.
//
// `containers` (issue #123): the plan lists each docker-container row that is over and has a proven id (`containerIdExact`, the
// mark of the parser: issue #231), unless the container is gone (`containerGone`). It is off until `trackers.processes.
// destroyContainers` is on: the plan says `skipped: not enabled`, and `--yes containers` runs no Docker call. Then each step
// checks the world again, in this order: the switch, the row, a live state, a gone container, the proof, the name, the form of
// the id, and one `docker container inspect --format` line (`INSPECT_FORMAT`) of the id, which must say that the id is the
// row's, the state is `exited`, no label key starts with `org.testcontainers`, `Created` is not before `firstSeen` less the
// spawn window, and the container has the `--name` of the row (`containerKeepReason`). A row with no `--name` is never a step
// (`NO_OWN_NAME`): its id may be another command's output, and nothing else says that the run made the container. A row whose run
// was not the whole Bash call (`containerRunAlone` is missing: the call is one lone `docker run -d`, with no list, pipe, redirection,
// substitution, assignment or wrapper) is never a step either (`NOT_ALONE`): a
// `--name` does not mend it, because Docker keeps names unique, so a run that failed on a taken name pairs with the id of the old
// container that holds the name, and that container passes every check of the inspect. Only then
// `docker rm <id>` runs, by argument vector, with no `-f` and no `-v`: a volume never goes. The first answer that says Docker
// is not there (the binary, the limit of the inspect, or the daemon) skips the rest of the container steps with the same
// reason and no more calls. The `docker rm` has its own limit (`REMOVE_TIMEOUT_MS`): one that does not finish skips only its
// own step. The row gets `containerGone` at once after a `done` and after `No such container`, so a second `--yes` has no
// step; it keeps its state until its TTL. A person's own shell, and a Docker context other than the default one, are not seen.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design studies: issue #49, R11a;
// issue #123, sections 5.3 and 5.6.

import type { CleanResult, CleanStep, Cleanup } from '../../core/interfaces/clean'
import type { Json } from '../../core/interfaces/items'
import type { RunResult, StopResult } from '../../core/interfaces/ports'
import type { TrackerContext } from '../../core/interfaces/tracker'
import { firstLine, message } from '../../core/lib/text'
import type { ProcessesConfig } from './config'
import { containerKeepReason, hasOwnName, INSPECT_FORMAT, NO_OWN_NAME, NOT_ALONE, parseInspectLine } from './probe'
import { applyContainerGone, applyTaskUpdate, asRows, readRows } from './rows'
import { ENDED_STATES } from './states'
import type { ProcessRecord } from './types'

type Ctx = TrackerContext<ProcessesConfig, Json>

const NOT_ENABLED = 'not enabled'
const NOT_PROVEN = 'the container id is not proven'
const GONE = 'the container is gone'
const UNREADABLE = 'docker gave an answer the mod cannot read'

/** The step of a running task row. A row with no task id or a Monitor row is listed with the reason it is not stopped. */
function stepOf(r: ProcessRecord): CleanStep | undefined {
  if (r.state !== 'running' || (r.kind !== 'background-task' && r.kind !== 'monitor')) return undefined
  const base = { kind: 'tasks', id: r.id, label: r.name, action: 'stop' } as const
  if (r.kind === 'monitor') return { ...base, skip: 'a Monitor task is not stopped yet' }
  return r.taskId === undefined || r.taskId === '' ? { ...base, skip: 'no task id' } : base
}

/**
 * The step of a container row, with the first reason that fits (design study of #123, section 5.3). A row that is live (a
 * running container is never planned) or marked gone is no step: nothing is left to remove, and a step would be tried, and so
 * logged, on each `--yes`. A row with no id, with an id that no run proved, with no `--name` or with a run that was not the whole Bash call is listed with its reason. The
 * switch comes last, so with it off the plan still says which rows would be steps. What needs Docker shows only in the result
 * of `--yes`.
 */
function containerStepOf(r: ProcessRecord, enabled: boolean): CleanStep | undefined {
  if (r.kind !== 'docker-container' || !ENDED_STATES.has(r.state) || r.containerGone === true) return undefined
  const base = { kind: 'containers', id: r.id, label: r.name, action: 'remove-container' } as const
  if (r.containerId === undefined || r.containerId === '') return { ...base, skip: 'no container id' }
  if (r.containerIdExact !== true) return { ...base, skip: NOT_PROVEN }
  if (!hasOwnName({ containerId: r.containerId, name: r.name })) return { ...base, skip: NO_OWN_NAME }
  if (r.containerRunAlone !== true) return { ...base, skip: NOT_ALONE }
  return enabled ? base : { ...base, skip: NOT_ENABLED }
}

/** The outcome of a `tasks` step: `done`, or why the task was not stopped. The row is read again, from `rows`. */
async function stopTask(ctx: Ctx, rows: readonly ProcessRecord[], step: CleanStep): Promise<string> {
  // The row is read again: a step is judged on the row of now, and only its own task id goes to the port.
  const taskId = rows.find(r => r.id === step.id)?.taskId
  if (taskId === undefined || taskId === '') return 'skipped: the row is gone'
  if (ctx.tasks === undefined) return 'skipped: no task port'
  let stopped: StopResult
  try {
    stopped = await ctx.tasks.stop(taskId)
  } catch (e) {
    return `skipped: ${message(e)}`
  }
  if (!stopped.stopped) return `skipped: ${stopped.reason}`
  // The task is stopped. A refused row write does not undo that: the task notice, or the next TaskStop answer, fixes the row.
  try {
    await applyTaskUpdate(ctx, { taskId, state: 'killed' }, ctx.clock.wall())
  } catch (e) {
    ctx.log(`processes: row of ${step.id} not marked killed: ${message(e)}`)
  }
  return 'done'
}

/** What the apply remembers across the container steps: the first answer that said Docker is not there. */
type DockerState = { down?: string }

/**
 * A message of Docker that says the daemon cannot be reached, as each client words it. The binary missing is a rejection of the
 * runner, not a message. The first two are the old CLI text (still printed for a stale socket and a TCP host). They are one
 * message with two phrases ("Cannot connect to the Docker daemon at ... Is the docker daemon running?"). They stay a pair on
 * purpose: a client that prints only one of them still matches, and the tests pin each phrase on its own. The third is the text of
 * Docker CLI 29 for an absent socket (a stopped Docker Desktop or Colima): `if the daemon is running` is too loose to match
 * alone. Then Docker Desktop on Windows, a user that is not in the `docker` group, and a `DOCKER_CONTEXT` or `DOCKER_HOST` that
 * cannot be resolved (no call can work until it is fixed).
 */
const DAEMON_DOWN = new RegExp(
  [
    'cannot connect to the docker daemon',
    'is the docker daemon running',
    'failed to connect to the docker api',
    'error during connect',
    'permission denied while trying to connect',
    'failed to initialize: unable to resolve docker endpoint',
  ].join('|'),
  'i',
)
const NO_SUCH_CONTAINER = /no such container/i

/** A full container id: 64 lower-case hex digits. The id goes to an argument vector, so it must not be able to read as an option. */
const FULL_ID = /^[0-9a-f]{64}$/

/**
 * The limit of the one `docker rm`: a remove can run far longer than an inspect, for a big writable layer, and a kill at the
 * probe limit would report a slow remove as a failure. The worktree remove has 120 s for the same reason (`trackers/auto/
 * clean.ts`, `REMOVE_TIMEOUT_MS`; design study of #123, G9). The inspect keeps `probeTimeoutMs`.
 */
const REMOVE_TIMEOUT_MS = 120_000

/** The end of a step that Docker stopped (`gone`: the container is not there; `down`: Docker is not there). */
type Stop = { stop: string; gone?: true; down?: true }

/** One Docker call: its answer, the first line of the rejection of the runner, or the outcome that ends the step. */
type Asked = { ok: RunResult } | { rejected: string } | Stop

/**
 * Runs `docker <argv>` and sorts the answer: an exit 0 is `ok`. A rejection of the runner (the binary is not on PATH, or the
 * call ran past `timeoutMs`) is `rejected`: what it means depends on the call, so the caller decides. A message that says the
 * daemon cannot be reached is `down`. `No such container` is `gone`. Any other non-zero exit stops the step with its first
 * line of stderr, after `prefix`.
 */
async function ask(ctx: Ctx, argv: readonly string[], timeoutMs: number, prefix: string): Promise<Asked> {
  let r: RunResult
  try {
    r = await ctx.tools.run('docker', ['docker', ...argv], { timeoutMs })
  } catch (e) {
    return { rejected: firstLine(message(e)) }
  }
  if (r.exitCode === 0) return { ok: r }
  const line = firstLine(r.stderr) || `exit ${r.exitCode}`
  if (NO_SUCH_CONTAINER.test(r.stderr)) return { stop: `skipped: ${GONE}`, gone: true }
  if (DAEMON_DOWN.test(r.stderr)) return { stop: `skipped: docker could not run: ${line}`, down: true }
  return { stop: `skipped: ${prefix}${line}` }
}

/** The row has `containerGone` once the container is not there. A refused write does not undo what Docker did. */
async function markGone(ctx: Ctx, rowId: string, containerId: string): Promise<void> {
  try {
    await applyContainerGone(ctx, rowId, containerId, true)
  } catch (e) {
    ctx.log(`processes: row of ${rowId} not marked gone: ${message(e)}`)
  }
}

/**
 * The outcome of a `containers` step. Everything is read now, at this step: the switch, the row, and Docker. The cheap checks
 * come first, so a step that no plan gave (the switch turned off, a row that changed since the plan) never reaches Docker.
 */
async function removeContainer(ctx: Ctx, step: CleanStep, docker: DockerState): Promise<string> {
  if (!ctx.config.slice().destroyContainers) return `skipped: ${NOT_ENABLED}`
  const r = (await readRows(ctx)).find(x => x.id === step.id)
  if (r === undefined || r.kind !== 'docker-container' || r.containerId === undefined || r.containerId === '')
    return 'skipped: the row is gone'
  if (!ENDED_STATES.has(r.state)) return `skipped: the container is ${r.state}`
  if (r.containerGone === true) return `skipped: ${GONE}`
  if (r.containerIdExact !== true) return `skipped: ${NOT_PROVEN}`
  const id = r.containerId
  if (!hasOwnName({ containerId: id, name: r.name })) return `skipped: ${NO_OWN_NAME}`
  if (r.containerRunAlone !== true) return `skipped: ${NOT_ALONE}`
  if (!FULL_ID.test(id)) return 'skipped: the container id is not a full id'
  if (docker.down !== undefined) return docker.down
  // What a call that Docker stopped leaves behind: Docker is not there (the later steps make no call), or the container is gone.
  const stopped = async (a: Stop): Promise<string> => {
    if (a.down) docker.down = a.stop
    if (a.gone) await markGone(ctx, step.id, id)
    return a.stop
  }
  const inspected = await ask(
    ctx,
    ['container', 'inspect', '--format', INSPECT_FORMAT, id],
    ctx.config.slice().probeTimeoutMs,
    'docker failed: ',
  )
  // The first call that is rejected (the binary is missing, or the probe limit ran out) means Docker could not run: the later
  // steps make no call, so a daemon that hangs costs one limit, not one for each step. This is fail-soft.
  if ('rejected' in inspected)
    return stopped({ stop: `skipped: docker could not run: ${inspected.rejected}`, down: true })
  if ('stop' in inspected) return stopped(inspected)
  const line = inspected.ok.isStdoutTruncated === true ? undefined : parseInspectLine(inspected.ok.stdout)
  if (line === undefined) return `skipped: ${UNREADABLE}`
  const keep = containerKeepReason(
    { containerId: id, name: r.name, firstSeen: r.firstSeen, containerRunAlone: r.containerRunAlone },
    line,
  )
  if (keep !== undefined) return `skipped: ${keep}`
  // No `-f`: Docker refuses a running container. No `-v`: an anonymous volume stays.
  const removed = await ask(ctx, ['rm', id], REMOVE_TIMEOUT_MS, '')
  if ('ok' in removed) {
    await markGone(ctx, step.id, id)
    return 'done'
  }
  // The inspect just answered, so the binary and the daemon are there: a rejection of the rm is its limit. The remove may have
  // finished, so the row is not marked and Docker is not `down`. The next probe, or the next inspect, finds out.
  if ('rejected' in removed) return `skipped: docker rm did not finish, the container may be gone: ${removed.rejected}`
  return stopped(removed)
}

export const processesCleanup: Cleanup<ProcessesConfig, Json> = {
  plan: ctx => {
    const enabled = ctx.config.slice().destroyContainers
    return asRows(ctx.data).flatMap(r => stepOf(r) ?? containerStepOf(r, enabled) ?? [])
  },

  async apply(ctx, steps) {
    const rows = await readRows(ctx)
    const docker: DockerState = {}
    const out: CleanResult[] = []
    for (const step of steps) {
      const outcome =
        step.kind === 'containers' ? await removeContainer(ctx, step, docker) : await stopTask(ctx, rows, step)
      out.push({ id: step.id, outcome })
    }
    return out
  },
}

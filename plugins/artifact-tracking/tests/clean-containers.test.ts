// `/track clean` for containers (issue #123, PR 2): the processes tracker plans a `docker rm` for each exited container that
// this run started, and applies it after `--yes containers` only when `destroyContainers` is on and the container passes
// every check of one `docker container inspect`: the id, the state `exited`, no Testcontainers label, a creation time that is
// not before the row was seen (less 11 minutes), and the `--name` of the row. A row with no `--name` is never removed. The world is the pane world over fake ports:
// `run` answers like Docker, and no real container starts. Order and causality are checked, never time.
import { expect, test } from 'claude-code/testing'
import type { CleanStep } from '../core/interfaces/clean'
import type { RunResult } from '../core/interfaces/ports'
import { processesCleanup } from '../trackers/processes/clean'
import { PROCESSES_DEFAULTS } from '../trackers/processes/config'
import { parseBashProcesses } from '../trackers/processes/parse'
import { INSPECT_FORMAT, SPAWN_WINDOW_MS } from '../trackers/processes/probe'
import { ENDED_STATES } from '../trackers/processes/states'
import type { ProcessRecord } from '../trackers/processes/types'
import { noDockerIssue, proc, setProcesses } from './fixtures/hide-world'
import { storedLog } from './fixtures/log'
import { NOW, paneWorld } from './fixtures/pane-world'

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string, exitCode = 1): RunResult => ({ exitCode, stdout: '', stderr })

const ID = 'a'.repeat(64)
const ID2 = 'b'.repeat(64)
const ID3 = 'c'.repeat(64)
/** When the Bash call of the row ended. `Created` is a little before it, as a lone `docker run -d` leaves it (S1 L102). */
const SEEN = NOW - 5_000
const iso = (ms: number): string => new Date(ms).toISOString()
/** Why a row with no `--name` is never removed: its id is all that says that the run made the container. */
const NO_NAME = 'no --name, so nothing proves that this run made the container'
/** Why a row whose run was not the whole Bash call is never removed: the id may be another command's. */
const NOT_ALONE = 'the run was not the whole Bash call, so nothing proves that this run made the container'
const NO_CONTAINER = (id: string) => `Error response from daemon: No such container: ${id}`
const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
/** What each client says when the daemon cannot be reached. The first is the old wording, still printed for a stale socket or a TCP host. */
const DOWN_WORDINGS: Record<string, string> = {
  'Docker 28 and older, or a TCP host': DAEMON_DOWN,
  // The old text is one message with two phrases. A client that prints only one of them still counts as down, and each phrase is
  // pinned on its own: the mutant that drops either one fails the two loops below.
  'a client that prints only the first phrase': 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
  'a client that prints only the second phrase': 'Is the docker daemon running?',
  // Docker CLI 29.9.2, `DOCKER_HOST=unix:///nonexistent.sock docker container inspect abc` and `docker rm abc` (exit 1). A
  // stopped Docker Desktop or Colima prints it: no alternative of the old wording matches it.
  'Docker 29, the socket is absent':
    'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory',
  'Linux, the user is not in the docker group':
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: connect: permission denied',
  'Docker Desktop on Windows':
    'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/x/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.',
  // Docker CLI 29.9.2, `DOCKER_CONTEXT=nonexistent-ctx docker container inspect abc`: no call can work until the context is fixed.
  'a DOCKER_CONTEXT that does not exist':
    'Failed to initialize: unable to resolve docker endpoint: context "nonexistent-ctx": context not found: open /home/u/.docker/contexts/meta/f3dc/meta.json: no such file or directory',
}

type Inspect = Partial<Record<'id' | 'status' | 'created' | 'name' | 'labels', string>>
/** The answer of `docker container inspect --format INSPECT_FORMAT <id>`: five fields with real tabs. */
const inspected = (id: string, f: Inspect = {}): RunResult =>
  ok(
    `${[
      f.id ?? id,
      f.status ?? 'exited',
      f.created ?? iso(SEEN - 3088),
      f.name ?? '/gallant_curie',
      f.labels ?? '{}',
    ].join('\t')}\n`,
  )

/** An exited container row with a proven id, as the parser leaves it once the probe saw the container exit. */
const ctr = (name: string, f: Partial<ProcessRecord> = {}): ProcessRecord =>
  proc(`docker:ctr:${name}`, 'exited', {
    kind: 'docker-container',
    name,
    containerId: ID,
    containerIdExact: true,
    containerRunAlone: true,
    firstSeen: SEEN,
    lastSeen: SEEN,
    endedAt: SEEN + 1000,
    ...f,
  })
/** A row with no `--name`: named by the first 12 characters of its id, as the parser names it. */
const unnamed = (id: string, f: Partial<ProcessRecord> = {}): ProcessRecord =>
  ctr(id.slice(0, 12), { id: `docker:ctr:${id}`, containerId: id, ...f })

type Opts = {
  rows?: ProcessRecord[]
  /** `destroyContainers`. Default: on. */
  enabled?: boolean
  /** The answer of `docker container inspect`, by container id. Default: an exited container that fits the row. */
  inspect?: (id: string) => RunResult | Promise<RunResult>
  /** The answer of `docker rm`, by container id. Default: exit 0 with the id. */
  rm?: (id: string) => RunResult | Promise<RunResult>
}

async function ctrWorld(o: Opts = {}) {
  const t = await paneWorld({ config: { processes: { destroyContainers: o.enabled ?? true } } })
  noDockerIssue(t)
  setProcesses(t, o.rows ?? [ctr('api')])
  t.w.run = async argv => {
    if (argv[0] !== 'docker') return fail('unexpected call')
    if (argv[1] === 'container' && argv[2] === 'inspect') {
      const id = argv.at(-1) ?? ''
      // The container of a row is named as the row is (`--name api` gives `/api`), so a named row passes the name check.
      const name = (t.w.state.get('processes') as unknown as ProcessRecord[]).find(r => r.containerId === id)?.name
      return (await o.inspect?.(id)) ?? inspected(id, { name: `/${name ?? 'gallant_curie'}` })
    }
    if (argv[1] === 'rm') {
      const id = argv.at(-1) ?? ''
      return (await o.rm?.(id)) ?? ok(`${id}\n`)
    }
    return fail(`unexpected docker call: ${argv.join(' ')}`)
  }
  const run = (args: string) => t.m.track(t.w.ports, args)
  const dockers = () => t.w.calls.filter(c => c[0] === 'docker')
  /** The verb of each docker call, in order: `inspect <id>`, `rm <id>`. */
  const verbs = () => dockers().map(c => (c[1] === 'container' ? `inspect ${c.at(-1)}` : `${c[1]} ${c.at(-1)}`))
  const log = () => storedLog(t.w.store)
  const row = (id: string) => (t.w.state.get('processes') as unknown as ProcessRecord[]).find(r => r.id === id)
  return { ...t, run, dockers, verbs, log, row }
}

// ---------------------------------------------------------------- the plan

// R1 (container half): the switch is off by default, and the plan says so. Nothing is tried, so nothing is logged.
test('with destroyContainers off an exited container with a proven id is skipped: not enabled, and --yes runs no docker', async () => {
  const t = await ctrWorld({ enabled: false })
  expect((await t.run('clean')).text).toContain(
    'Containers (apply with /track clean --yes containers)\n  api: skipped: not enabled\n',
  )
  const text = (await t.run('clean --yes containers')).text
  expect(text).toContain('  api: skipped: not enabled')
  expect(t.dockers()).toEqual([])
  expect(t.log()).toEqual([])
  expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
})

test('with it on the same container is a remove step, and a dry run runs no docker', async () => {
  const t = await ctrWorld()
  expect((await t.run('clean')).text).toContain(
    'Containers (apply with /track clean --yes containers)\n  api: remove\n',
  )
  expect(t.dockers()).toEqual([])
  expect(t.log()).toEqual([])
  expect(t.w.stateSets.processes).toBeUndefined() // a plan writes nothing
})

test('the default of the switch is off, so a world with no config line plans skipped: not enabled', async () => {
  expect(PROCESSES_DEFAULTS.destroyContainers).toBe(false)
  const t = await paneWorld()
  noDockerIssue(t)
  setProcesses(t, [ctr('api')])
  expect((await t.m.track(t.w.ports, 'clean')).text).toContain('  api: skipped: not enabled\n')
})

// R2: which rows are steps.
test('a running container is no step, and a name-only row and a row with no proof are listed with their reason', async () => {
  const t = await ctrWorld({
    rows: [
      ctr('up', { state: 'up', containerId: ID }),
      ctr('running', { state: 'running', containerId: ID2 }),
      ctr('unhealthy', { state: 'unhealthy', containerId: ID3 }),
      ctr('named', { containerId: undefined, containerIdExact: undefined }),
      ctr('guessed', { containerId: ID2, containerIdExact: undefined }), // a row of an older build: an id, no mark
    ],
  })
  const text = (await t.run('clean')).text
  expect(text).toContain(
    'Containers (apply with /track clean --yes containers)\n' +
      '  named: skipped: no container id\n' +
      '  guessed: skipped: the container id is not proven\n',
  )
  for (const live of ['up', 'running', 'unhealthy']) expect(text).not.toContain(`  ${live}:`)
  await t.run('clean --yes containers')
  expect(t.dockers()).toEqual([]) // none of them reaches docker
  expect(t.log()).toEqual([])
})

test('only a docker-container row is a step: a compose project, a tmux session and a task are not', async () => {
  const t = await ctrWorld({
    rows: [
      proc('docker:compose:p', 'exited', { kind: 'docker-compose', name: 'p', project: 'p' }),
      proc('tmux:dev', 'exited', { kind: 'tmux', name: 'dev' }),
      proc('task:1', 'completed', { name: 'job', taskId: '1' }),
    ],
  })
  const text = (await t.run('clean')).text
  expect(text).not.toContain('Containers (')
  expect(text).toContain('Nothing to stop or remove.')
})

test('with the switch off the plan still names the first reason that fits, and a live row is no step', async () => {
  const t = await ctrWorld({
    enabled: false,
    rows: [
      ctr('named', { containerId: undefined, containerIdExact: undefined }),
      ctr('guessed', { containerId: ID2, containerIdExact: undefined }),
      unnamed(ID2.replace(/b/g, 'd')),
      ctr('crowded', { containerId: ID3.replace(/c/g, 'e'), containerRunAlone: undefined }),
      ctr('proven', { containerId: ID3 }),
      ctr('up', { state: 'up', containerId: ID }),
    ],
  })
  const text = (await t.run('clean')).text
  expect(text).toContain(
    '  named: skipped: no container id\n  guessed: skipped: the container id is not proven\n' +
      `  ${'d'.repeat(12)}: skipped: ${NO_NAME}\n  crowded: skipped: ${NOT_ALONE}\n  proven: skipped: not enabled\n`,
  )
  expect(text).not.toContain('  up:')
})

test('every ended state is a step, and a row marked containerGone is none', async () => {
  const states = [...ENDED_STATES]
  const idOf = (n: number): string => n.toString(16).repeat(64)
  const t = await ctrWorld({
    rows: [
      ...states.map((state, n) => ctr(`s-${state}`, { containerId: idOf(n), state })),
      ctr('gone', { containerId: idOf(states.length), state: 'exited', containerGone: true }),
    ],
  })
  expect(states.length).toBeGreaterThan(2) // the set is read, not copied: a new end state joins the test
  const text = (await t.run('clean')).text
  for (const state of states) expect(text, state).toContain(`  s-${state}: remove\n`)
  expect(text).not.toContain('  gone:')
})

// ---------------------------------------------------------------- the apply

// AC2: inspect, then `docker rm <id>` by argument vector, once, in that order.
test('--yes containers inspects the container, then runs docker rm <id> once, by argument vector, with no -f and no -v', async () => {
  const t = await ctrWorld()
  const text = (await t.run('clean --yes containers')).text
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`])
  expect(t.dockers()).toEqual([
    ['docker', 'container', 'inspect', '--format', INSPECT_FORMAT, ID],
    ['docker', 'rm', ID],
  ])
  expect(text).toContain('Cleaned: containers.')
  expect(text).toContain('  api: done')
})

// G9 (study of #123): a remove can run far longer than a read, so `docker rm` has its own limit, as `git worktree remove` has.
test('docker inspect runs with the probe timeout of the processes config, and docker rm with its own 120 s limit', async () => {
  const t = await ctrWorld()
  await t.run('clean --yes containers')
  const opts = t.w.calls.flatMap((c, i) => (c[0] === 'docker' ? [t.w.callOpts[i]] : []))
  expect(opts).toHaveLength(2)
  expect(opts[0]?.timeoutMs).toBe(PROCESSES_DEFAULTS.probeTimeoutMs) // inspect
  expect(opts[1]?.timeoutMs).toBe(120000) // rm
})

// G12, R8: after the remove the row has containerGone at once, so a second --yes has no step.
test('after a remove the row is marked containerGone at once: the next plan and a second --yes run no docker and log nothing', async () => {
  const t = await ctrWorld()
  await t.run('clean --yes containers')
  expect(t.row('docker:ctr:api')).toMatchObject({ state: 'exited', containerGone: true }) // it stays exited until its TTL (G18)
  expect(t.log()).toHaveLength(1)
  const before = t.dockers().length
  expect((await t.run('clean')).text).not.toContain('Containers (')
  const again = (await t.run('clean --yes containers')).text
  expect(again).toContain('Nothing to do.')
  expect(t.dockers()).toHaveLength(before)
  expect(t.log()).toHaveLength(1)
})

// R6: one entry of the audit log for each tried step, with the row id and no label.
test('the audit log gets one entry for each tried step: kind containers, the row id, remove-container, and no label', async () => {
  const t = await ctrWorld({
    rows: [
      ctr('api'),
      ctr('db', { containerId: ID2 }),
      ctr('named', { containerId: undefined, containerIdExact: undefined }),
      unnamed(ID3),
    ],
  })
  await t.run('clean --yes containers')
  expect(t.log()).toEqual([
    { at: NOW, by: 'manual', kind: 'containers', id: 'docker:ctr:db', action: 'remove-container', outcome: 'done' },
    { at: NOW, by: 'manual', kind: 'containers', id: 'docker:ctr:api', action: 'remove-container', outcome: 'done' },
  ]) // the row with no id and the row with no --name were skipped at plan time: no entry
  expect(JSON.stringify(t.log())).not.toContain('gallant') // nothing of the answer of docker
  const logText = (await t.run('clean --log')).text
  expect(logText).toContain('containers  docker:ctr:api  remove-container  done')
})

// ---------------------------------------------------------------- the checks of the inspect answer

const kept = async (inspect: Opts['inspect'], reason: string, row: ProcessRecord = ctr('api')) => {
  const t = await ctrWorld({ rows: [row], ...(inspect !== undefined ? { inspect } : {}) })
  const text = (await t.run('clean --yes containers')).text
  expect(text, reason).toContain(`  ${row.name}: skipped: ${reason}`)
  expect(t.verbs(), reason).toEqual([`inspect ${row.containerId}`]) // no rm
  expect(t.log().map(e => e.outcome)).toEqual([`skipped: ${reason}`])
  expect(t.row(row.id)?.containerGone).toBeUndefined() // the container still exists
  expect(t.row(row.id)?.state).toBe('exited')
}

test('a container that docker says is running (or any state but exited) is kept: the container is <status>', async () => {
  await kept(id => inspected(id, { status: 'running' }), 'the container is running')
  await kept(id => inspected(id, { status: 'created' }), 'the container is created')
  await kept(id => inspected(id, { status: 'paused' }), 'the container is paused')
})

test('a Testcontainers label keeps the container, with or without a suffix: managed by Testcontainers', async () => {
  await kept(id => inspected(id, { labels: '{"org.testcontainers":"true"}' }), 'managed by Testcontainers')
  await kept(id => inspected(id, { labels: '{"org.testcontainers.sessionId":"x"}' }), 'managed by Testcontainers')
})

test('a container created more than 11 minutes before the row was seen is kept; 3088 ms before it, as S1 saw, is removed', async () => {
  await kept(id => inspected(id, { created: iso(SEEN - SPAWN_WINDOW_MS - 1) }), 'created before the row was seen')
  const t = await ctrWorld({ inspect: id => inspected(id, { created: iso(SEEN - 3088), name: '/api' }) })
  await t.run('clean --yes containers')
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`])
})

test('a creation time that is no date keeps the container: cannot read the creation time (G19)', async () => {
  await kept(id => inspected(id, { created: 'garbage' }), 'cannot read the creation time')
})

test('Docker reads nanoseconds in Created: the fraction is cut before the date is read', async () => {
  const created = iso(SEEN - 1000).replace('.000Z', '.123456789Z')
  const t = await ctrWorld({ inspect: id => inspected(id, { created, name: '/api' }) })
  await t.run('clean --yes containers')
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`])
})

test('a row named by --name needs that name on the container: the name is not <name>', async () => {
  await kept(id => inspected(id, { name: '/web' }), 'the name is not api')
  const t = await ctrWorld({ inspect: id => inspected(id, { name: '/api' }) })
  await t.run('clean --yes containers')
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`])
})

// Review of PR 285, P1. The id of a row can be another command's output (the known limits of the pairing), and a row with no
// `--name` has no name to check, so the window of `Created` alone cannot tell the container of the run from one that someone else
// made a few minutes before. Such a row is never removed: the plan says why, and the apply asks Docker nothing.
test('a row with no --name is skipped, however the container looks: no docker call, no entry of the log', async () => {
  const t = await ctrWorld({ rows: [unnamed(ID)], inspect: id => inspected(id, { name: '/gallant_curie' }) })
  expect((await t.run('clean')).text).toContain(`  ${ID.slice(0, 12)}: skipped: ${NO_NAME}\n`)
  const text = (await t.run('clean --yes containers')).text
  expect(text).toContain(`  ${ID.slice(0, 12)}: skipped: ${NO_NAME}`)
  expect(t.dockers()).toEqual([])
  expect(t.log()).toEqual([])
  expect(t.row(`docker:ctr:${ID}`)?.containerGone).toBeUndefined()
})

// The case of the review: the run never ran (`false && ...`), and the one id line is the output of another command. The parser
// pairs it (the known limits, `process-parse.test.ts`), so the row has the mark and the name of the id. The container is an
// exited one that someone else made a minute before the call, so every check of the inspect passes except the missing name.
test('a run that never ran, paired with the id of another command, never removes that container', async () => {
  const [made] = parseBashProcesses(`false && docker run -d nginx; printf '%s\\n' ${ID}`, {
    result: { stdout: `${ID}\n` },
  })
  expect(made).toMatchObject({ kind: 'docker-container', containerId: ID, containerIdExact: true }) // the premise
  const row: ProcessRecord = {
    ...(made as ProcessRecord),
    state: 'exited',
    firstSeen: SEEN,
    lastSeen: SEEN,
    endedAt: SEEN + 1000,
  }
  const t = await ctrWorld({
    rows: [row],
    inspect: id => inspected(id, { name: '/someone-elses', created: iso(SEEN - 60_000) }),
  })
  const text = (await t.run('clean --yes containers')).text
  expect(text).toContain(`: skipped: ${NO_NAME}`)
  expect(t.verbs()).toEqual([]) // no inspect, and no rm
  expect(t.log()).toEqual([])
})

// Review of PR 285, P1 again: the name check is no proof for a row with a `--name`. A run that failed because the name is taken
// (or never ran) prints no id, and the one id line of another command pairs with it. The old container carries the name of the
// row, so every check of the inspect passes. Only the call tells the two apart: another command of it prints.
test('a named run that never ran, paired with the id of another command, never removes the container that has its name', async () => {
  const [made] = parseBashProcesses(`false && docker run -d --name api nginx; printf '%s\\n' ${ID}`, {
    result: { stdout: `${ID}\n` },
  })
  expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
  const row: ProcessRecord = {
    ...(made as ProcessRecord),
    state: 'exited',
    firstSeen: SEEN,
    lastSeen: SEEN,
    endedAt: SEEN + 1000,
  }
  // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
  const t = await ctrWorld({ rows: [row], inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }) })
  expect((await t.run('clean')).text).toContain(`  api: skipped: ${NOT_ALONE}\n`)
  const text = (await t.run('clean --yes containers')).text
  expect(text).toContain(`  api: skipped: ${NOT_ALONE}`)
  expect(t.verbs()).toEqual([]) // no inspect, and no rm
  expect(t.log()).toEqual([])
  expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
})

// Second review of PR 285, P1: a redirection is no proof that the output of a command goes away. `printf ... 3>&1 >&3` prints the id
// of the old container on the original standard output, so it is the one id line that the run (which never ran) pairs with.
// The call is more than the one run (the lone-command rule of the parser): the row is not alone, and nothing is removed.
test('a redirected command that still prints the id of another container keeps the run from being alone: no inspect, no rm', async () => {
  for (const command of [
    `false && docker run -d --name api nginx; printf '%s\\n' ${ID} 3>&1 >&3`,
    `false && docker run -d --name api nginx; printf '%s\\n' ${ID} > /dev/stdout`,
    `false && docker run -d --name api nginx; printf '%s\\n' ${ID} | tee /dev/stdout | true`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// Third review of PR 285, P1: a command substitution that stands where the parser cannot read it still runs, and it can print the id
// of the old container. `splitShell` leaves a substitution inside double quotes in its word, a heredoc body is skipped, and the
// target of a redirection is dropped, so the command around it (`:`, an assignment) looked like one that prints nothing. The
// parser must withhold `containerRunAlone` for a call with a `$(...)` or a backtick that it has not read: nothing is removed.
test('a command substitution that the parser cannot read keeps the run from being alone: no inspect, no rm', async () => {
  const printId = `printf '%s\\n' ${ID} >&3`
  for (const command of [
    // The command of the review: a quoted substitution in the argument of `:`, under a group that copies the output to fd 3.
    `false && docker run -d --name api nginx; { : "$(${printId})"; } 3>&1`,
    `false && docker run -d --name api nginx; { true "$(${printId})"; } 3>&1`,
    // The same in an assignment: a line of assignments has no command, so the walk never asked if it prints.
    `false && docker run -d --name api nginx; { x="$(${printId})"; } 3>&1`,
    // A backtick pair inside double quotes is a substitution too.
    `false && docker run -d --name api nginx; { : "\`${printId}\`"; } 3>&1`,
    // The body of a heredoc with no quoted tag is expanded, and the target of a redirection is too.
    `false && docker run -d --name api nginx; { : <<EOF\n$(${printId})\nEOF\n} 3>&1`,
    `false && docker run -d --name api nginx; { : > "$(${printId})"; } 3>&1`,
    // Single quotes pass the text on, and the shell still runs it: as arithmetic (`[[ 'a[$(...)]' -eq 1 ]]`), as a prompt (`PS4`
    // with `set -x`, and `${x@P}`). Each of these printed the id in bash 5.3.20.
    `false && docker run -d --name api nginx; { [[ 'a[$(${printId})]' -eq 1 ]]; } 3>&1`,
    `false && docker run -d --name api nginx; { PS4='$(${printId})'; set -x; :; } 3>&1`,
    `false && docker run -d --name api nginx; x='$(${printId})'; { : "\${x@P}"; } 3>&1`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// The tests from here to the one of the eighth review keep the commands of the review rounds 4 to 8. Since the lone-command rule
// (ninth round) each of them withholds through the outer rule: the call is more than one `docker run -d`. The guard for the one
// command, which their comments name, is gone. The tests stay as proof that each shape removes nothing.
//
// Fourth review of PR 285, P1: `set -x` prints each command as it runs, with the text of `PS4` before it, and `BASH_XTRACEFD=1` sends the
// trace to the tool result. A `PS4` that holds the id of an old container prints it as a bare line, though the run never ran (`false &&`)
// and the command has no `$(` and no backtick. The parser must not read `set -x` (or `set -v`, which echoes the input lines) as a
// command that prints nothing: the row is not alone, and nothing is removed. Bash 5.3.20 printed the id for the first command.
test('a set that turns a trace or the echo on keeps the run from being alone: no inspect, no rm', async () => {
  for (const command of [
    `BASH_XTRACEFD=1; PS4=$'${ID}\\n'; set -x; false && docker run -d --name api nginx`,
    `BASH_XTRACEFD=1; PS4=$'${ID}\\n'; set -o xtrace; false && docker run -d --name api nginx`,
    `set -euxo pipefail; false && docker run -d --name api nginx`,
    `set -v; false && docker run -d --name api nginx; : <<EOF\n${ID}\nEOF`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// Fifth review of PR 285, P1: `cd -` goes to `$OLDPWD` and prints it. With a relative `OLDPWD=<id>` that is a bare id line (bash 5.3.20), the
// call has no `$(`, no trace and no redirection, and the parser read `cd` as a builtin that prints nothing. The run never ran (`false &&`),
// so the row paired with the id of another container, got `containerRunAlone`, and `--yes containers` removed that container. `main`
// has neither the mark nor a removal, so the new code caused it. The parser must read a `cd` or a `pushd` that can go back (`-`, or a
// word that expands or globs) as a command that may print: the row is not alone, and nothing is removed.
test('a cd - that prints the old directory keeps the run from being alone: no inspect, no rm', async () => {
  for (const command of [
    `false && docker run -d --name api nginx; OLDPWD=${ID}; cd -`,
    `false && docker run -d --name api nginx; OLDPWD=${ID}; cd -P -`,
    `false && docker run -d --name api nginx; OLDPWD=${ID}; cd -- -`,
    `false && docker run -d --name api nginx; OLDPWD=${ID}; pushd -`,
    `false && docker run -d --name api nginx; OLDPWD=${ID}; d=-; cd $d`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// Sixth review of PR 285, P1: a `set` with no word lists every shell variable and then every function, and bash prints a function body
// with the `$'\nid\n'` word of its command as a quoted string that spans lines, so the id is a bare line on the result. The call has no
// `$(`, no trace and no redirection, and the parser read a bare `set` as a builtin that prints nothing. The run never ran (`false &&`),
// so the row paired with the id of another container, got `containerRunAlone`, and `--yes containers` removed that container. `main`
// has neither the mark nor a removal, so the new code caused it. Bash 5.3.20 and 3.2.57 printed the id for the first command. The
// bare `export` of bash 3.2.57 and `export -f` (every bash) list in the same way, so they are read as commands that may print.
test('a bare set or a listing export keeps the run from being alone: no inspect, no rm', async () => {
  for (const command of [
    `true() { : $'\\n${ID}\\n'; }; false && docker run -d --name api nginx; set`,
    `f() { : $'\\n${ID}\\n'; }; export -f f; false && docker run -d --name api nginx; export -f`,
    `x=$'\\n${ID}\\n'; export x; false && docker run -d --name api nginx; export`,
    `x=$'\\n${ID}\\n'; export x; false && docker run -d --name api nginx; export -p`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// Seventh review of PR 285, P1 (thread 1): `stripLead` drops a wrapper in front of a command, and with no command behind it the segment
// is empty and the walk skipped it before it asked if the segment prints. `env` with no command prints the environment, and a value
// with a newline puts a bare id on a line of its own (bash 5.3.20 and 3.2.57). The run never ran (`false &&`), so the row paired with
// the id of another container, got `containerRunAlone`, and `--yes containers` removed that container. `main` has neither the mark
// nor a removal, so the new code caused it. `time` prints its report to stderr, and `TIMEFORMAT` shapes it. The parser must read a
// wrapper that stands with no command (and `time`, with or without one) as a command that may print: not alone, nothing removed.
test('a wrapper with no command that prints keeps the run from being alone: no inspect, no rm', async () => {
  for (const command of [
    `export X=$'\\n${ID}\\n'; false && docker run -d --name api nginx; env`,
    `export X=$'\\n${ID}\\n'; false && docker run -d --name api nginx; env -i X=$'\\n${ID}\\n'`,
    `export X=$'\\n${ID}\\n'; false && docker run -d --name api nginx; command env`,
    `TIMEFORMAT=$'\\n${ID}\\n'; false && docker run -d --name api nginx; time`,
    `TIMEFORMAT=$'\\n${ID}\\n'; false && docker run -d --name api nginx; time true`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// Seventh review of PR 285, P1 (thread 2): a `set` option word that globs is the option after the shell has run it. With a file named `-x`
// in the directory, `set -?` is `set -x`, and `BASH_XTRACEFD=1; PS4=$'<id>\n'` prints the id (bash 5.3.20). The parser read the literal
// letters and the `$` of an option word only. `main` has neither the mark nor a removal, so the new code caused it. A word with a glob
// or brace character before the end of the options counts as a `set` that may turn a trace on: not alone, nothing removed.
test('a set option word that globs keeps the run from being alone: no inspect, no rm', async () => {
  for (const command of [
    `BASH_XTRACEFD=1; PS4=$'${ID}\\n'; set -?; false && docker run -d --name api nginx`,
    `BASH_XTRACEFD=1; PS4=$'${ID}\\n'; set *; false && docker run -d --name api nginx`,
    `BASH_XTRACEFD=1; PS4=$'${ID}\\n'; set {-x,}; false && docker run -d --name api nginx`,
    `BASH_XTRACEFD=1; PS4=$'${ID}\\n'; set -o xtr?ce; false && docker run -d --name api nginx`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// Eighth review of PR 285, P1: a builtin that "prints nothing" prints its operand in a diagnostic when it fails. `[ 0 -eq $'\n<id>\n' ] 2>&1`
// never runs Docker, and bash prints `[: <newline><id><newline>: integer expression expected` (bash 5.3.20 and 3.2.57), so the id of another
// container is a bare line on the result. The run never ran (`false &&`), so the row paired with that id, got `containerRunAlone`, and
// `--yes containers` removed the container. `main` has neither the mark nor a removal, so the new code caused it. A builtin whose operand can
// hold a newline (`$`, `~`, a glob character, a newline in quotes) counts as a command that may print: not alone, nothing removed.
test('a builtin whose diagnostic can print an operand keeps the run from being alone: no inspect, no rm', async () => {
  for (const command of [
    `false && docker run -d --name api nginx; [ 0 -eq $'\\n${ID}\\n' ] 2>&1`,
    `false && docker run -d --name api nginx; test 0 -eq $'\\n${ID}\\n'`,
    `false && docker run -d --name api nginx; sleep $'\\n${ID}\\n'`,
    `false && docker run -d --name api nginx; wait $'\\n${ID}\\n'`,
    `false && docker run -d --name api nginx; unset $'\\n${ID}\\n'`,
    `false && docker run -d --name api nginx; true \${x?$'\\n${ID}\\n'}`,
    `false && docker run -d --name api nginx; export a$'\\n${ID}\\n'`,
    `false && docker run -d --name api nginx; set -o $'\\n${ID}\\n'`,
    `false && docker run -d --name api nginx; OLDPWD=$'\\n${ID}\\n'; [ 0 -eq ~- ]`,
    `false && docker run -d --name api nginx; X=$'\\n${ID}\\n'; [ 0 -eq "$X" ]`,
    `false && docker run -d --name api nginx; [ 0 -eq '\n${ID}\n' ]`,
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    expect(made).toMatchObject({ kind: 'docker-container', name: 'api', containerId: ID, containerIdExact: true }) // the premise
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
    expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  }
})

// Ninth review of PR 285 (the lone-command rule). A failed redirection, a failed `${y?...}` on a line of assignments and a wrapper
// before `docker` each put a command or a word around the run that the parser had not read as one that prints (the open thread of
// round nine: `: 2>&1 > $'\n<id>\n/absent'`). The mark now goes only to a call that is one `docker run -d` and nothing else, so each
// of them is no step, and the same run alone is. Through the real parser and `--yes containers`.
test('only a lone docker run -d earns the removal: a failed redirection, a failed expansion and a wrapper keep the run from being alone', async () => {
  const nl = `$'\\n${ID}\\n'`
  for (const command of [
    `false && docker run -d --name api nginx; true < ${nl}`,
    `false && docker run -d --name api nginx; : 2>&1 > $'\\n${ID}\\n/absent'`,
    `false && docker run -d --name api nginx; x=\${y?${nl}}`,
    'env docker run -d --name api nginx',
    'docker run -d --name api nginx && docker logs api',
    'docker run -d --name api nginx > out',
  ]) {
    const [made] = parseBashProcesses(command, { result: { stdout: `${ID}\n` } })
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      containerId: ID,
      containerIdExact: true,
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    expect(row.containerRunAlone, command).toBeUndefined()
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect(`${command}\n${(await t.run('clean')).text}`).toContain(`  api: skipped: ${NOT_ALONE}\n`)
    expect(`${command}\n${(await t.run('clean --yes containers')).text}`).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs()).toEqual([]) // no inspect, and no rm
    expect(t.log()).toEqual([])
  }
  // The lone run, with its id line in the result, is a step: the inspect agrees, and the container goes.
  const [lone] = parseBashProcesses('docker run -d --name api nginx', { result: { stdout: `${ID}\n` } })
  expect(lone).toMatchObject({ containerId: ID, containerIdExact: true, containerRunAlone: true }) // the premise
  const t = await ctrWorld({
    rows: [{ ...(lone as ProcessRecord), state: 'exited', firstSeen: SEEN, lastSeen: SEEN, endedAt: SEEN + 1000 }],
    inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
  })
  expect((await t.run('clean --yes containers')).text).toContain('  api: done')
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`])
})

// Round ten of PR 285 (P1). A backslash before a newline continues the line only outside single quotes. In single quotes the word keeps
// both, and Docker prints the part after the newline on a line of its own: this is what Docker 29.9.2 printed for the call below, with
// the id of another container (`ID`) after the newline. The run never made a container, and the mod must not remove the old one that
// holds the name `api`. The row comes from the real parser, with nothing forced.
test('a backslash and a newline in single quotes put an id on a line of its own: the run is not alone, so no inspect and no rm', async () => {
  const refused = (arg: string) =>
    `invalid argument ${JSON.stringify(arg)} for "--dns" flag: IP address is not correctly formatted: ${arg}\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun 'docker run --help' for more information\n`
  for (const [command, arg] of [
    [`docker run -d --name api --dns '\\\n${ID}' nginx`, `\\\n${ID}`],
    [`docker run -d --name api --dns '\\\\\\\n${ID}' nginx`, `\\\\\\\n${ID}`],
    [`docker run -d --name api --label "'" --dns '\\\n${ID}' nginx`, `\\\n${ID}`],
  ] as const) {
    const [made] = parseBashProcesses(command, { result: { stdout: refused(arg) } })
    expect(made, command).toMatchObject({ containerId: ID, containerIdExact: true }) // the premise: the id pairs
    expect((made as ProcessRecord).containerRunAlone, command).toBeUndefined()
    const row: ProcessRecord = {
      ...(made as ProcessRecord),
      state: 'exited',
      firstSeen: SEEN,
      lastSeen: SEEN,
      endedAt: SEEN + 1000,
    }
    // An exited container of the name `api`, made a minute before the call, by someone else: it passes every check of the inspect.
    const t = await ctrWorld({
      rows: [row],
      inspect: id => inspected(id, { name: '/api', created: iso(SEEN - 60_000) }),
    })
    expect((await t.run('clean --yes containers')).text, command).toContain(`  api: skipped: ${NOT_ALONE}`)
    expect(t.verbs(), command).toEqual([]) // no inspect, and no rm
    expect(t.log(), command).toEqual([])
  }
})

test('a row whose run was not alone is skipped, however the container looks: no docker call, no entry of the log', async () => {
  const t = await ctrWorld({ rows: [ctr('api', { containerRunAlone: undefined })] })
  expect((await t.run('clean')).text).toContain(`  api: skipped: ${NOT_ALONE}\n`)
  expect((await t.run('clean --yes containers')).text).toContain(`  api: skipped: ${NOT_ALONE}`)
  expect(t.dockers()).toEqual([])
  expect(t.log()).toEqual([])
})

test('a --name row that ran again days later keeps its first firstSeen and takes the new id: the new container passes', async () => {
  const days = 3 * 86_400_000
  const t = await ctrWorld({
    rows: [ctr('api', { firstSeen: SEEN, containerId: ID2 })],
    inspect: id => inspected(id, { name: '/api', created: iso(SEEN + days) }), // no upper bound
  })
  await t.run('clean --yes containers')
  expect(t.verbs()).toEqual([`inspect ${ID2}`, `rm ${ID2}`])
})

test('docker names another container than the row: docker named another container, and no rm', async () => {
  await kept(() => inspected(ID, { id: ID2 }), 'docker named another container')
})

test('an answer that is not the five fields, or is cut, keeps the container: docker gave an answer the mod cannot read', async () => {
  await kept(() => ok('exited\n'), 'docker gave an answer the mod cannot read')
  await kept(() => ok(''), 'docker gave an answer the mod cannot read')
  await kept(() => ({ ...inspected(ID), isStdoutTruncated: true }), 'docker gave an answer the mod cannot read')
})

// ---------------------------------------------------------------- Docker says no

test('No such container from inspect: skipped: the container is gone, the row is marked, and the next plan has no step', async () => {
  const t = await ctrWorld({ inspect: id => fail(NO_CONTAINER(id)) })
  const text = (await t.run('clean --yes containers')).text
  expect(text).toContain('  api: skipped: the container is gone')
  expect(t.verbs()).toEqual([`inspect ${ID}`]) // no rm for a container that is not there
  expect(t.row('docker:ctr:api')?.containerGone).toBe(true)
  expect(t.log().map(e => e.outcome)).toEqual(['skipped: the container is gone']) // one entry for the try, then no more
  expect((await t.run('clean')).text).not.toContain('Containers (')
  await t.run('clean --yes containers')
  expect(t.verbs()).toEqual([`inspect ${ID}`])
  expect(t.log()).toHaveLength(1)
})

test('No such container from rm (a --rm container that went between the two calls): skipped: the container is gone, and marked', async () => {
  const t = await ctrWorld({ rm: id => fail(NO_CONTAINER(id)) })
  const text = (await t.run('clean --yes containers')).text
  expect(text).toContain('  api: skipped: the container is gone')
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`])
  expect(t.row('docker:ctr:api')?.containerGone).toBe(true)
})

test('rm exits 1 for another reason: skipped: <first line of stderr>, and the row keeps its state', async () => {
  const t = await ctrWorld({
    rm: id => fail(`Error response from daemon: cannot remove container "${id}": container is running\nsecond line`),
  })
  const text = (await t.run('clean --yes containers')).text
  expect(text).toContain(
    `  api: skipped: Error response from daemon: cannot remove container "${ID}": container is running`,
  )
  expect(text).not.toContain('second line')
  expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined()
  expect(t.row('docker:ctr:api')?.state).toBe('exited')
  expect(t.log().map(e => e.outcome)).toHaveLength(1)
})

test('inspect exits non-zero for another reason: skipped: docker failed: <first line>, and no rm', async () => {
  const t = await ctrWorld({ inspect: () => fail('Error: something else\nmore') })
  expect((await t.run('clean --yes containers')).text).toContain('  api: skipped: docker failed: Error: something else')
  expect(t.verbs()).toEqual([`inspect ${ID}`])
})

// R7: the first answer that says docker is not there costs one call, and the other container steps make none. Each client has
// its own words for it, and a text that the mod does not know costs one call for each step: so each one is a test of its own.
for (const [client, text] of Object.entries(DOWN_WORDINGS)) {
  test(`the daemon is down (${client}): the first step makes one call, and the others none, all skipped with the same reason`, async () => {
    const t = await ctrWorld({
      rows: [ctr('a', { containerId: ID }), ctr('b', { containerId: ID2 }), ctr('c', { containerId: ID3 })],
      inspect: () => fail(text),
    })
    const out = (await t.run('clean --yes containers')).text
    expect(t.dockers()).toHaveLength(1)
    const reason = `skipped: docker could not run: ${text}`
    for (const name of ['a', 'b', 'c']) expect(out).toContain(`  ${name}: ${reason}`)
    // Each was tried, and each says why it did nothing. The log cuts a long outcome, so only its start is compared.
    const outcomes = t.log().map(e => e.outcome)
    expect(outcomes).toHaveLength(3)
    expect(new Set(outcomes).size).toBe(1)
    expect(outcomes[0]).toContain(reason.slice(0, 80))
  })
}

test('docker is not installed (the runner rejects): one call, the same reason for every step, and tasks still run', async () => {
  const t = await ctrWorld({
    rows: [
      ctr('a', { containerId: ID }),
      ctr('b', { containerId: ID2 }),
      proc('task:t1', 'running', { name: 'sleep 9', taskId: 't1' }),
    ],
    inspect: () => {
      throw new Error('ENOENT: docker not found')
    },
  })
  const text = (await t.run('clean --yes tasks containers')).text
  expect(t.dockers()).toHaveLength(1)
  expect(text).toContain('  a: skipped: docker could not run: ENOENT: docker not found')
  expect(text).toContain('  b: skipped: docker could not run: ENOENT: docker not found')
  expect(t.w.stops).toEqual(['t1']) // docker missing never stops the other kinds
  expect(t.row('task:t1')?.state).toBe('killed')
})

for (const [client, text] of Object.entries(DOWN_WORDINGS)) {
  test(`the daemon goes down (${client}) at the rm of the second container: the third step makes no call`, async () => {
    const t = await ctrWorld({
      rows: [ctr('a', { containerId: ID }), ctr('b', { containerId: ID2 }), ctr('c', { containerId: ID3 })],
      rm: id => (id === ID2 ? fail(text) : ok(`${id}\n`)),
    })
    const out = (await t.run('clean --yes containers')).text
    expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`, `inspect ${ID2}`, `rm ${ID2}`])
    expect(out).toContain('  a: done')
    expect(out).toContain(`  b: skipped: docker could not run: ${text}`)
    expect(out).toContain(`  c: skipped: docker could not run: ${text}`)
  })
}

test('inspect exits non-zero with no stderr: skipped: docker failed: exit 2, and no rm', async () => {
  const t = await ctrWorld({ inspect: () => fail('', 2) })
  expect((await t.run('clean --yes containers')).text).toContain('  api: skipped: docker failed: exit 2')
  expect(t.verbs()).toEqual([`inspect ${ID}`])
})

// A rejection of the runner is a missing binary or a timeout. Either way inspect, the first call, could not run docker, so the
// other steps make no call: fail-soft, and the result names the reason.
test('inspect that is rejected for another reason than a missing binary (a timeout) ends the container steps: one call', async () => {
  const t = await ctrWorld({
    rows: [ctr('a', { containerId: ID }), ctr('b', { containerId: ID2 })],
    inspect: () => {
      throw new Error('timed out')
    },
  })
  const text = (await t.run('clean --yes containers')).text
  expect(t.dockers()).toHaveLength(1)
  expect(text).toContain('  a: skipped: docker could not run: timed out')
  expect(text).toContain('  b: skipped: docker could not run: timed out')
})

// G9: the rm is the one call that can take long. The binary and the daemon answered inspect, so a rejection of the rm is a
// timeout: the container may be gone, the mod does not know, and the other steps still run.
test('a docker rm that does not finish (the runner rejects) is skipped, the row is not marked, and the next step still runs', async () => {
  const t = await ctrWorld({
    rows: [ctr('a', { containerId: ID }), ctr('b', { containerId: ID2 })],
    rm: id => {
      if (id === ID) throw new Error('timed out')
      return ok(`${id}\n`)
    },
  })
  const text = (await t.run('clean --yes containers')).text
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`, `inspect ${ID2}`, `rm ${ID2}`])
  expect(text).toContain('  a: skipped: docker rm did not finish, the container may be gone: timed out')
  expect(text).toContain('  b: done')
  expect(t.row('docker:ctr:a')?.containerGone).toBeUndefined() // not known: the next probe, or the next inspect, finds out
  expect(t.row('docker:ctr:b')?.containerGone).toBe(true)
  expect((await t.run('clean')).text).toContain('  a: remove') // still a step
})

test('one failed step never stops the others: a container that docker keeps is skipped, the rest are removed', async () => {
  const names: Record<string, string> = { [ID]: 'a', [ID2]: 'b', [ID3]: 'c' }
  const t = await ctrWorld({
    rows: [ctr('a', { containerId: ID }), ctr('b', { containerId: ID2 }), ctr('c', { containerId: ID3 })],
    inspect: id => inspected(id, { name: `/${names[id]}`, ...(id === ID2 ? { status: 'running' } : {}) }),
  })
  const text = (await t.run('clean --yes containers')).text
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`, `inspect ${ID2}`, `inspect ${ID3}`, `rm ${ID3}`])
  expect(text).toContain('  a: done')
  expect(text).toContain('  b: skipped: the container is running')
  expect(text).toContain('  c: done')
  expect(['a', 'b', 'c'].map(n => t.row(`docker:ctr:${n}`)?.containerGone)).toEqual([true, undefined, true])
})

// ---------------------------------------------------------------- the other kinds, and the world of now

test('a clean of containers stops no task, and a clean of tasks runs no docker', async () => {
  const t = await ctrWorld({ rows: [ctr('api'), proc('task:t1', 'running', { name: 'sleep 9', taskId: 't1' })] })
  await t.run('clean --yes containers')
  expect(t.w.stops).toEqual([])
  await t.run('clean --yes tasks')
  expect(t.w.stops).toEqual(['t1'])
  expect(t.verbs()).toEqual([`inspect ${ID}`, `rm ${ID}`]) // the tasks run added no docker call
})

test('the apply judges the row of now: a container that was running again since the last plan is not removed', async () => {
  const t = await ctrWorld()
  expect((await t.run('clean')).text).toContain('  api: remove')
  setProcesses(t, [ctr('api', { state: 'running', endedAt: undefined })])
  await t.run('clean --yes containers')
  expect(t.dockers()).toEqual([])
  expect(t.log()).toEqual([])
})

test('a write of containerGone that the slot refuses does not undo the remove: the step still reads done', async () => {
  const t = await ctrWorld()
  const slot = t.w.ports.state.slot.update
  t.w.ports.state.slot.update = async (id, fn) => {
    if (id === 'processes') throw new Error('state refused')
    return slot(id, fn)
  }
  expect((await t.run('clean --yes containers')).text).toContain('  api: done')
  expect(t.log().map(e => e.outcome)).toEqual(['done'])
  expect(t.row('docker:ctr:api')?.containerGone).toBeUndefined() // the write was refused
  expect((await t.run('clean')).text).toContain('  api: remove') // still a step until the next probe marks it
})

// ---------------------------------------------------------------- the apply on its own: the guards that do not rely on the plan

const stepOf = (id: string): CleanStep => ({ kind: 'containers', id, label: id, action: 'remove-container' })

/** The apply over a hand-made context: the rows it reads, the switch, and the docker it may run. */
function applyOf(
  rows: ProcessRecord[],
  o: { enabled?: boolean; run?: (argv: readonly string[]) => Promise<RunResult> } = {},
) {
  const calls: string[][] = []
  const written: ProcessRecord[][] = []
  const ctx = {
    data: {
      get: async () => rows,
      update: async (fn: (cur: ProcessRecord[]) => ProcessRecord[]) => {
        written.push(fn(rows))
        return rows
      },
    },
    config: { slice: () => ({ ...PROCESSES_DEFAULTS, destroyContainers: o.enabled ?? true }) },
    tools: {
      run: async (_tool: string, argv: readonly string[]) => {
        calls.push([...argv])
        return (await o.run?.(argv)) ?? inspected(ID, { name: '/api' })
      },
    },
    clock: { wall: () => NOW },
    log: () => {},
  } as unknown as Parameters<typeof processesCleanup.apply>[0]
  return { apply: (...ids: string[]) => processesCleanup.apply(ctx, ids.map(stepOf)), calls, written }
}

test('apply: a step whose row is gone or has no id runs no docker: skipped: the row is gone', async () => {
  const a = applyOf([ctr('named', { containerId: undefined, containerIdExact: undefined })])
  expect(await a.apply('docker:ctr:nope', 'docker:ctr:named')).toEqual([
    { id: 'docker:ctr:nope', outcome: 'skipped: the row is gone' },
    { id: 'docker:ctr:named', outcome: 'skipped: the row is gone' },
  ])
  expect(a.calls).toEqual([])
})

test('apply: a step that no plan gave is judged again: not enabled, not proven, no --name, not alone, not a container id, gone, or live', async () => {
  const rows = [
    ctr('guess', { containerIdExact: undefined }),
    unnamed(ID2),
    ctr('short', { containerId: 'abc123', containerIdExact: true }),
    ctr('flag', { containerId: '--force', containerIdExact: true }),
    ctr('crowded', { containerRunAlone: undefined }),
    ctr('gone', { containerGone: true }),
    ctr('live', { state: 'running' }),
  ]
  const on = applyOf(rows)
  expect(
    await on.apply(
      'docker:ctr:guess',
      `docker:ctr:${ID2}`,
      'docker:ctr:crowded',
      'docker:ctr:short',
      'docker:ctr:flag',
      'docker:ctr:gone',
      'docker:ctr:live',
    ),
  ).toEqual([
    { id: 'docker:ctr:guess', outcome: 'skipped: the container id is not proven' },
    { id: `docker:ctr:${ID2}`, outcome: `skipped: ${NO_NAME}` },
    { id: 'docker:ctr:crowded', outcome: `skipped: ${NOT_ALONE}` },
    { id: 'docker:ctr:short', outcome: 'skipped: the container id is not a full id' },
    { id: 'docker:ctr:flag', outcome: 'skipped: the container id is not a full id' },
    { id: 'docker:ctr:gone', outcome: 'skipped: the container is gone' },
    { id: 'docker:ctr:live', outcome: 'skipped: the container is running' },
  ])
  expect(on.calls).toEqual([])
  const off = applyOf([ctr('api')], { enabled: false })
  expect(await off.apply('docker:ctr:api')).toEqual([{ id: 'docker:ctr:api', outcome: 'skipped: not enabled' }])
  expect(off.calls).toEqual([])
})

test('apply: the happy path runs inspect and rm by the id of the row and marks the row by that id only', async () => {
  const a = applyOf([ctr('api'), ctr('other', { containerId: ID2 })], {
    run: async argv => (argv[1] === 'rm' ? ok(`${ID}\n`) : inspected(ID, { name: '/api' })),
  })
  expect(await a.apply('docker:ctr:api')).toEqual([{ id: 'docker:ctr:api', outcome: 'done' }])
  expect(a.calls.map(c => c.slice(0, 3))).toEqual([
    ['docker', 'container', 'inspect'],
    ['docker', 'rm', ID],
  ])
  expect(a.written).toHaveLength(1)
  expect(a.written[0]?.map(r => [r.id, r.containerGone])).toEqual([
    ['docker:ctr:api', true],
    ['docker:ctr:other', undefined],
  ])
})

test('apply: a row that a new run gave another container while rm ran is not marked gone', async () => {
  const rows = [ctr('api')]
  const a = applyOf(rows, {
    run: async argv => {
      if (argv[1] !== 'rm') return inspected(ID, { name: '/api' })
      rows[0] = ctr('api', { containerId: ID2 }) // the same row id runs again before the write
      return ok(`${ID}\n`)
    },
  })
  expect(await a.apply('docker:ctr:api')).toEqual([{ id: 'docker:ctr:api', outcome: 'done' }])
  expect(rows[0]?.containerGone).toBeUndefined()
  expect(a.written.every(w => w[0]?.containerGone === undefined)).toBe(true)
})

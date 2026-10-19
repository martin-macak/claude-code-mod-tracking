import { isRecord } from '../../core/lib/json'
import { resolvePath, scopedDir, splitShell, stripWrappers } from '../../core/lib/shell'
import type { ProcessRecord, ProcessState } from './types'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const TASK_DONE: Record<string, ProcessState> = { completed: 'completed', failed: 'failed', killed: 'killed' }

const shortCmd = (command: string): string => command.replace(/\s+/g, ' ').trim().slice(0, 80)

/** Long enough to tell processes apart, short enough to store. */
const FINGERPRINT_MAX = 200

const baseName = (w: string): string => w.slice(w.lastIndexOf('/') + 1)

// ---------------------------------------------------------------- paths

function pathBase(path: string | undefined): string | undefined {
  if (!path) return undefined
  const last = path.split('/').filter(Boolean).at(-1)
  return last === undefined || last === '..' || last === '.' || last === '~' ? undefined : last
}

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '.')

// ---------------------------------------------------------------- flags

/** Reads one getopt cluster (`-dmS name`). `values` lists the letters that take a value. */
function shortCluster(
  words: readonly string[],
  i: number,
  values: string,
): { letters: string; value?: { letter: string; text: string | undefined }; next: number } {
  const body = words[i]!.slice(1)
  for (let k = 0; k < body.length; k++) {
    const ch = body[k]!
    if (!values.includes(ch)) continue
    const rest = body.slice(k + 1)
    if (rest !== '') return { letters: body.slice(0, k + 1), value: { letter: ch, text: rest }, next: i + 1 }
    return { letters: body.slice(0, k + 1), value: { letter: ch, text: words[i + 1] }, next: i + 2 }
  }
  return { letters: body, next: i + 1 }
}

// ---------------------------------------------------------------- docker

const DOCKER_GLOBAL_VALUES = new Set(['--context', '-c', '--host', '-H', '--config', '--log-level', '-l'])

// `docker run` flags that take a value. Anything else that starts with `-` is a switch.
const RUN_LONG_VALUES = new Set(
  (
    '--add-host --annotation --attach --blkio-weight --cap-add --cap-drop --cgroup-parent --cgroupns --cidfile ' +
    '--cpu-period --cpu-quota --cpu-rt-period --cpu-rt-runtime --cpu-shares --cpus --cpuset-cpus --cpuset-mems ' +
    '--device --device-cgroup-rule --dns --dns-option --dns-search --domainname --entrypoint --env --env-file ' +
    '--expose --gpus --group-add --health-cmd --health-interval --health-retries --health-start-period ' +
    '--health-timeout --hostname --ip --ip6 --ipc --isolation --label --label-file --link --log-driver --log-opt ' +
    '--mac-address --memory --memory-reservation --memory-swap --mount --name --network --net --network-alias ' +
    '--pid --platform --publish --pull --restart --runtime --security-opt --shm-size --stop-signal ' +
    '--stop-timeout --storage-opt --sysctl --tmpfs --ulimit --user --userns --uts --volume --volumes-from --workdir'
  ).split(' '),
)
const RUN_SHORT_VALUES = 'acehlmpuvw'

type DockerCall =
  | { kind: 'run'; args: string[] }
  | { kind: 'compose'; args: string[] }
  | { kind: 'other' }
  | { kind: 'none' }

function dockerCall(words: readonly string[]): DockerCall {
  const bin = baseName(words[0] ?? '')
  if (bin === 'docker-compose') return { kind: 'compose', args: words.slice(1) }
  if (bin !== 'docker') return { kind: 'none' }
  let i = 1
  while (i < words.length && words[i]!.startsWith('-')) i += DOCKER_GLOBAL_VALUES.has(words[i]!) ? 2 : 1
  const sub = words[i]
  if (sub === 'run') return { kind: 'run', args: words.slice(i + 1) }
  if (sub === 'container' && words[i + 1] === 'run') return { kind: 'run', args: words.slice(i + 2) }
  if (sub === 'compose') return { kind: 'compose', args: words.slice(i + 1) }
  return { kind: 'other' }
}

/** Reads the `docker run` options up to the image. Flags after the image belong to the container command. */
function runOptions(args: readonly string[]): { detach: boolean; name?: string } {
  let detach = false
  let name: string | undefined
  let i = 0
  while (i < args.length) {
    const w = args[i]!
    if (w === '--' || !w.startsWith('-') || w === '-') break
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const flag = eq === -1 ? w : w.slice(0, eq)
      const inline = eq === -1 ? undefined : w.slice(eq + 1)
      const takes = RUN_LONG_VALUES.has(flag) && inline === undefined
      const value = inline ?? (takes ? args[i + 1] : undefined)
      if (flag === '--detach') detach = inline === undefined || inline === 'true'
      if (flag === '--name') name = value
      i += takes ? 2 : 1
      continue
    }
    const c = shortCluster(args, i, RUN_SHORT_VALUES)
    if (c.letters.includes('d')) detach = true
    i = c.next
  }
  return name !== undefined ? { detach, name } : { detach }
}

const COMPOSE_GLOBAL_VALUES = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--project-directory',
  '--env-file',
  '--profile',
  '--ansi',
  '--progress',
  '--parallel',
])

type ComposeUp = { file?: string; project?: string; projectDir?: string }

/** `docker compose [globals] up [flags]` with a detach flag, else null. */
function composeUp(args: readonly string[]): ComposeUp | null {
  const out: ComposeUp = {}
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    const w = args[i]!
    const eq = w.indexOf('=')
    const flag = eq === -1 ? w : w.slice(0, eq)
    const takes = COMPOSE_GLOBAL_VALUES.has(flag) && eq === -1
    const value = eq === -1 ? (takes ? args[i + 1] : undefined) : w.slice(eq + 1)
    if ((flag === '-f' || flag === '--file') && out.file === undefined && value !== undefined) out.file = value
    if ((flag === '-p' || flag === '--project-name') && value !== undefined) out.project = value
    if (flag === '--project-directory' && value !== undefined) out.projectDir = value
    i += takes ? 2 : 1
  }
  if (args[i] !== 'up') return null
  const detached = args
    .slice(i + 1)
    .some(w => w === '--detach' || w === '--detach=true' || w === '--wait' || /^-[A-Za-z]*d[A-Za-z]*$/.test(w))
  return detached ? out : null
}

/** Compose's own rule: lower case, only a-z 0-9 _ -, starting with a letter or digit. */
const normalizeProject = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '')

/** -p, COMPOSE_PROJECT_NAME, --project-directory, the folder of the first -f file, then the cwd. */
function composeProject(up: ComposeUp, env: Record<string, string>, cwd: string | undefined): string {
  // A bare file name (or `-`, stdin) lives in the cwd: the last fallback covers it.
  const fromFile = up.file?.includes('/') ? pathBase(dirOf(resolvePath(cwd, up.file))) : undefined
  const raw =
    up.project ??
    env.COMPOSE_PROJECT_NAME ??
    pathBase(up.projectDir !== undefined ? resolvePath(cwd, up.projectDir) : undefined) ??
    fromFile ??
    pathBase(cwd)
  const name = raw !== undefined ? normalizeProject(raw) : ''
  return name || 'compose'
}

// ---------------------------------------------------------------- tmux and screen

const TMUX_GLOBAL_VALUES = 'cfLST'

/** `tmux new -d -s NAME`. Null when it is not a named detached session on the default socket. */
function tmuxSession(words: readonly string[]): string | null {
  if (baseName(words[0] ?? '') !== 'tmux') return null
  let i = 1
  while (i < words.length && words[i]!.startsWith('-')) {
    const c = shortCluster(words, i, TMUX_GLOBAL_VALUES)
    // Another socket (-L, -S) is not what the probe's `tmux ls` sees.
    if (c.value?.letter === 'L' || c.value?.letter === 'S') return null
    i = c.next
  }
  if (words[i] !== 'new' && words[i] !== 'new-session') return null
  i++
  let detached = false
  let name: string | undefined
  while (i < words.length && words[i]!.startsWith('-')) {
    const c = shortCluster(words, i, 'cefFnstxy')
    if (c.letters.includes('d')) detached = true
    if (c.value?.letter === 's') name = c.value.text
    i = c.next
  }
  // tmux turns `.` and `:` in a session name into `_`.
  return detached && name ? name.replace(/[.:]/g, '_') : null
}

/** `screen -dmS NAME`, in any flag order. -D -m stays in the foreground, so it is not a detached session. */
function screenSession(words: readonly string[]): string | null {
  if (baseName(words[0] ?? '') !== 'screen') return null
  let i = 1
  let d = false
  let m = false
  let name: string | undefined
  while (i < words.length && words[i]!.startsWith('-')) {
    if (words[i]!.startsWith('-Logfile')) {
      i += 2
      continue
    }
    const c = shortCluster(words, i, 'SceEhpsTtX')
    if (c.letters.includes('d')) d = true
    if (c.letters.includes('m')) m = true
    if (c.value?.letter === 'S') name = c.value.text
    i = c.next
  }
  return d && m && name ? name : null
}

// ---------------------------------------------------------------- stdout

/** `docker run -d` prints the full id alone on a line. Other hex in the output (commit ids, digests) is not one. */
const containerIds = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => /^[a-f0-9]{64}$/.test(l))

/** Lines that `echo $!` (or `echo "pid: $!"`) prints. */
function pidLines(stdout: string): number[] {
  const out: number[] = []
  for (const line of stdout.split('\n')) {
    const raw = /^\s*(\d+)\s*$/.exec(line)?.[1] ?? /\bpid\b\D{0,5}(\d+)\s*$/i.exec(line)?.[1]
    const n = raw ? Number(raw) : NaN
    if (Number.isSafeInteger(n) && n > 1) out.push(n)
  }
  return out
}

const echoesPid = (words: readonly string[]): boolean =>
  (words[0] === 'echo' || words[0] === 'printf') && words.some(w => w.includes('$!'))

// ---------------------------------------------------------------- Bash

type TaskBackedUpdate = { taskId?: string; toolUseId?: string; state: ProcessState }

function backgroundRow(command: string, taskId: string, at: number, toolUseId?: string): ProcessRecord {
  return {
    id: `task:${taskId}`,
    kind: 'background-task',
    name: shortCmd(command),
    state: 'running',
    firstSeen: at,
    lastSeen: at,
    taskId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
  }
}

/** `setsid [-f] [-w] cmd`: forks on its own only with -f. */
function stripSetsid(words: string[]): { words: string[]; fork: boolean } {
  if (words[0] !== 'setsid') return { words, fork: false }
  let i = 1
  let fork = false
  while (i < words.length && words[i]!.startsWith('-')) {
    if (words[i] === '-f' || words[i] === '--fork') fork = true
    i++
  }
  return { words: words.slice(i), fork }
}

/** Shell builtins end with the shell: `echo x &` is no process to follow. */
const BUILTINS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  ':',
  'wait',
  'read',
  'test',
  '[',
  'set',
  'unset',
  'export',
])

type Detached = { fingerprint: string; pid?: number; viaShell: boolean }

/**
 * Rows for the long-lived things one Bash command starts. The command is split into simple commands first,
 * so `docker info; docker run -d ...` and `mkdir -p x && docker compose up -d` are both found.
 * `cwd` is the session's working directory; `cd` in the command moves it for the parts after it.
 */
export function parseBashProcesses(
  command: string,
  ran: unknown,
  toolUseId?: string,
  at = Date.now(),
  cwd?: string,
): ProcessRecord[] {
  const rows: ProcessRecord[] = []
  const result = isRecord(ran) && isRecord(ran.result) ? ran.result : null
  const stdout = str(result?.stdout) ?? ''

  const taskId = str(result?.backgroundTaskId)
  if (taskId) rows.push(backgroundRow(command, taskId, at, toolUseId))

  const runs: { name?: string; text: string }[] = []
  const detached: Detached[] = []
  let lastBg: Detached | undefined
  const pids = pidLines(stdout)
  // `export` stays global on purpose: a subshell scope is not tracked for env, only for the directory.
  const exported: Record<string, string> = {}
  const dirs = scopedDir(cwd)

  for (const seg of splitShell(command)) {
    const pre = stripWrappers(seg.words)
    const ss = stripSetsid(pre.words)
    const inner = stripWrappers(ss.words)
    const words = inner.words
    const env = { ...exported, ...pre.env, ...inner.env }
    if (words.length === 0) continue
    const head = words[0]!

    if (head === 'cd' || head === 'pushd') {
      const target = words.slice(1).find(w => !w.startsWith('-'))
      dirs.set(seg.scope, target === undefined || target === '~' ? undefined : resolvePath(dirs.get(seg.scope), target))
      continue
    }
    if (head === 'export') {
      for (const w of words.slice(1)) {
        const eq = w.indexOf('=')
        if (eq > 0) exported[w.slice(0, eq)] = w.slice(eq + 1)
      }
      continue
    }
    if (echoesPid(words)) {
      if (lastBg && lastBg.pid === undefined && !lastBg.viaShell) {
        const pid = pids.shift()
        if (pid !== undefined) lastBg.pid = pid
      }
      continue
    }

    const docker = dockerCall(words)
    if (docker.kind === 'run') {
      const o = runOptions(docker.args)
      if (o.detach) runs.push({ ...(o.name !== undefined ? { name: o.name } : {}), text: shortCmd(words.join(' ')) })
      continue
    }
    if (docker.kind === 'compose') {
      const up = composeUp(docker.args)
      if (up) {
        const project = composeProject(up, env, dirs.get(seg.scope))
        rows.push({
          id: `docker:compose:${project}`,
          kind: 'docker-compose',
          name: project,
          state: 'running',
          firstSeen: at,
          lastSeen: at,
          project,
        })
      }
      continue
    }
    if (docker.kind === 'other') continue

    const tmux = tmuxSession(words)
    if (tmux) {
      rows.push({ id: `tmux:${tmux}`, kind: 'tmux', name: tmux, state: 'running', firstSeen: at, lastSeen: at })
      continue
    }
    const screen = screenSession(words)
    if (screen) {
      rows.push({ id: `screen:${screen}`, kind: 'screen', name: screen, state: 'running', firstSeen: at, lastSeen: at })
      continue
    }

    if ((seg.bg || ss.fork) && !BUILTINS.has(head)) {
      const d: Detached = { fingerprint: words.join(' ').slice(0, FINGERPRINT_MAX), viaShell: ss.fork && !seg.bg }
      detached.push(d)
      lastBg = d
    }
  }

  // Ids pair with runs in order. With a count mismatch only a single run takes the last id.
  const ids = containerIds(stdout)
  runs.forEach((run, n) => {
    const containerId = ids.length === runs.length ? ids[n] : runs.length === 1 ? ids.at(-1) : undefined
    const name = run.name ?? containerId?.slice(0, 12) ?? run.text
    rows.push({
      id: `docker:ctr:${run.name ?? containerId ?? run.text}`,
      kind: 'docker-container',
      name,
      state: 'running',
      firstSeen: at,
      lastSeen: at,
      ...(containerId !== undefined ? { containerId } : {}),
    })
  })

  detached.forEach((d, n) => {
    rows.push({
      id: d.pid !== undefined ? `pid:${d.pid}` : `bg:${toolUseId ?? at}:${n}`,
      kind: 'detached-process',
      name: shortCmd(d.fingerprint),
      state: 'running',
      firstSeen: at,
      lastSeen: at,
      ...(d.pid !== undefined ? { pid: d.pid } : {}),
      fingerprint: d.fingerprint,
    })
  })
  return rows
}

export function monitorRow(taskId: string, at = Date.now(), toolUseId?: string): ProcessRecord {
  return {
    id: `monitor:${taskId}`,
    kind: 'monitor',
    name: 'Monitor',
    state: 'running',
    firstSeen: at,
    lastSeen: at,
    taskId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
  }
}

export function processUpdateFromNotification(task: unknown): TaskBackedUpdate | null {
  if (!isRecord(task)) return null
  const status = str(task.status)?.toLowerCase()
  if (!status) return null
  const state = TASK_DONE[status]
  if (!state) return null
  const taskId = str(task.id)
  const toolUseId = str(task.toolUseId)
  if (taskId === undefined && toolUseId === undefined) return null
  return { ...(taskId !== undefined ? { taskId } : {}), ...(toolUseId !== undefined ? { toolUseId } : {}), state }
}

export function processUpdateFromTaskStop(result: unknown): TaskBackedUpdate | null {
  const r = isRecord(result) ? result : null
  const taskId = str(r?.task_id)
  if (!taskId) return null
  return { taskId, state: 'killed' }
}

const tag = (text: string, name: string): string | undefined =>
  new RegExp(`<${name}>([^<\\n]+)</${name}>`).exec(text)?.[1]?.trim() || undefined

/**
 * The same update from a notification row's text. The engine stores no `task` field on the row (in the types it
 * is a render prop only), so the text is the source: `<task-id>`, `<tool-use-id>`, `<status>`.
 * The caller checks `origin.kind === 'task-notification'`: the person can type the same text.
 */
export function processUpdateFromNotificationText(text: string): TaskBackedUpdate | null {
  if (!text.includes('<task-notification>')) return null
  return processUpdateFromNotification({
    id: tag(text, 'task-id'),
    toolUseId: tag(text, 'tool-use-id'),
    status: tag(text, 'status'),
  })
}

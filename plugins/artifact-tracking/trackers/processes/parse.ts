import { isRecord } from '../../core/lib/json'
import {
  keepsStdout,
  resolvePath,
  type Segment,
  scopedCopy,
  scopedDir,
  scopedVars,
  splitShell,
  stripLead,
  stripWrappers,
  unmarkDollars,
} from '../../core/lib/shell'
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

/**
 * The id of each run, in order, or undefined (issue #231). `printed[n]`: the output of run n reaches the tool result. The id
 * lines pair in order with the runs that print when the counts match and no id repeats (two runs never print one id), or
 * when one run that prints stands with lines that all say one id (a later `docker inspect -f '{{.Id}}'` of it). Any other
 * count says that a line came from another command (`docker ps -aq`, an `inspect` of another container): no run takes an
 * id then. A run that does not print takes none, and it is left out of the count.
 */
export function pairContainerIds(ids: readonly string[], printed: readonly boolean[]): (string | undefined)[] {
  const printing = printed.filter(Boolean).length
  const unique = new Set(ids).size
  let next = 0
  return printed.map(p => {
    if (!p) return undefined
    const n = next++
    if (ids.length === printing) return unique === ids.length ? ids[n] : undefined
    return printing === 1 && unique === 1 ? ids[0] : undefined
  })
}

/** Lines that `echo $!` (or `echo "pid: $!"`) prints to the tool result. */
function pidLines(stdout: string): number[] {
  const out: number[] = []
  for (const line of stdout.split('\n')) {
    const raw = /^\s*(\d+)\s*$/.exec(line)?.[1] ?? /\bpid\b\D{0,5}(\d+)\s*$/i.exec(line)?.[1]
    const n = raw ? Number(raw) : NaN
    if (Number.isSafeInteger(n) && n > 1) out.push(n)
  }
  return out
}

/**
 * The segment prints `$!` to the tool result. Only then is a pid line of stdout its own. One whose output goes away prints no
 * line, so it takes none and drops none: `echo $! > pid.txt`, `echo $! | tee f`, `PID=$(echo $!)`, an `echo $!` in a redirected
 * group and one after `exec > f` (issue #231). `keepsStdout` holds the rule, as for the id of a container.
 */
const echoesPid = (seg: Segment, words: readonly string[]): boolean =>
  (words[0] === 'echo' || words[0] === 'printf') && words.some(w => w.includes('$!')) && keepsStdout(seg)

// ---------------------------------------------------------------- Bash

type TaskBackedUpdate = { taskId?: string; toolUseId?: string; state: ProcessState }

/** What names the row of a task beyond its command: the Bash or Monitor call, its agent and the end-with-agent flag. */
type BackgroundOf = { toolUseId?: string | undefined; agentId?: string | undefined; endsWithAgent?: boolean }

function backgroundRow(
  command: string,
  taskId: string,
  at: number,
  { toolUseId, agentId, endsWithAgent = false }: BackgroundOf = {},
): ProcessRecord {
  return {
    id: `task:${taskId}`,
    kind: 'background-task',
    name: shortCmd(command),
    state: 'running',
    firstSeen: at,
    lastSeen: at,
    taskId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(endsWithAgent ? { endsWithAgent: true as const } : {}),
  }
}

// ---------------------------------------------------------------- shell variables

/** `$NAME` and `${NAME}`. Group 1 is the braced name, group 2 the bare one. */
const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * Expands the variables the command set itself (`lookup`, for the shell that runs the word) and `$PWD` (`pwd`, the
 * directory of that shell). A name with no known value stays as typed: the probe then reads the word as a pattern
 * (`probe.ts`). The word is a marked one (`Segment.marked`): a `$` that the shell passes as typed (`'$F'`, `\$F`) is
 * no reference and stays. The result is marked too: `unmarkDollars` gives the text.
 */
function expandVars(word: string, lookup: (name: string) => string | undefined, pwd: string | undefined): string {
  return word.replace(VAR_REF, (whole, braced?: string, bare?: string) => {
    const name = (braced ?? bare) as string
    return name === 'PWD' ? (pwd ?? whole) : (lookup(name) ?? whole)
  })
}

/**
 * Names the command assigns with a command substitution: `D=$(mktemp -d)`, `D=/tmp/run-$(date +%s)`, ``D=`date` ``.
 * The shell splitter opens a scope of its own for the substitution and drops its text from the word, so the value reads
 * as `/tmp/run-`: a wrong literal. Such a name must stay a variable. A substitution inside quotes stays in the word, so
 * `D="x-$(date)"` does not count. The scan is by name, not by scope or position: a name that is opaque once stays opaque.
 */
function substitutedNames(command: string): ReadonlySet<string> {
  const assigned =
    /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:[^\s;&|"'`$]|\$(?!\()|"[^"]*"|'[^']*')*(?:\$\(|`)/g
  return new Set([...command.matchAll(assigned)].map(m => m[1] as string))
}

/** The values of an env record as the shell passes them. */
const plainEnv = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, unmarkDollars(v)]))

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

/** Shell builtins end with the shell: `echo x &` is no process to follow. `[[` is a keyword that works as one. */
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
  '[[',
  'set',
  'unset',
  'export',
])

type Detached = { fingerprint: string; pid?: number; viaShell: boolean }

/**
 * The last job that sets `$!` makes no row. Most of them have a shell of their own, so `$!` names that shell, not an earlier
 * job: a builtin of `BUILTINS` (`echo x &`), `cd`, a docker call, a backgrounded loop (`done &`), a group (`{ a; } &`), a
 * subshell whose last command is a builtin or a compound (`( sleep 3; : ) &`, `( : ) &`), or a `coproc` of a group or of a
 * builtin (`coproc NAME { a; }`, `coproc :`). Two forms make no row although `$!` names a process, because bash runs their
 * last command in place when it is an external simple command: a subshell (`( sleep 3 ) &`, `( true; sleep 3 ) &`) and a
 * `coproc` (`coproc sleep 3`). Both are limits, like `sleep $(a) &`. A builtin outside `BUILTINS`
 * (`pwd &`, `source f &`) does make a row, with the pid of its shell (a limit). The `echo $!` that prints it eats one pid
 * line of stdout: the next `echo $!` must not take that line (issue #132). An `echo $!` that prints elsewhere eats none.
 */
const NO_ROW: Detached = { fingerprint: '', viaShell: true }

/**
 * The Bash call around a command. `at` is the time the call was seen. `cwd` is the session's working directory, read
 * before the call. `agentId` is absent for the main loop.
 */
export type BashCall = {
  toolUseId?: string | undefined
  at?: number
  cwd?: string | undefined
  agentId?: string | undefined
}

/**
 * Rows for the long-lived things one Bash command starts. The command is split into simple commands first,
 * so `docker info; docker run -d ...` and `mkdir -p x && docker compose up -d` are both found.
 * `cd` in the command moves the working directory (`call.cwd`) for the parts after it.
 */
export function parseBashProcesses(
  command: string,
  ran: unknown,
  { toolUseId, at = Date.now(), cwd, agentId }: BashCall = {},
): ProcessRecord[] {
  const rows: ProcessRecord[] = []
  const result = isRecord(ran) && isRecord(ran.result) ? ran.result : null
  const stdout = str(result?.stdout) ?? ''

  const taskId = str(result?.backgroundTaskId)
  if (taskId)
    rows.push(
      backgroundRow(command, taskId, at, {
        toolUseId,
        agentId,
        endsWithAgent: result?.backgroundEndsWithFinalResponse === true, // the engine ends the task with its caller's final response
      }),
    )

  // `printed`: the standard output of the run reaches the tool result, so an id line can be its own (issue #231).
  const runs: { name?: string; text: string; printed: boolean }[] = []
  const detached: Detached[] = []
  const pids = pidLines(stdout)
  // One entry for each `echo $!` that prints a pid line, in order: the job that takes the line, or none when it names no row.
  // The lines pair with the entries after the scan, and only when there is one line for each entry (issue #231).
  const echoed: (Detached | undefined)[] = []
  const claimed = new Set<Detached>()
  // What `$!` names, per shell (issue #231). `last`: the job that `$!` names, or `NO_ROW` when it names a process with no row. It
  // is `undefined` before any `&`. `saw`: a `&` came before the segment, so `$!` is set and an `echo $!` prints a line. Before
  // any `&` it prints an empty line, and `setsid -f` forks on its own and sets no `$!`. A subshell, a substitution, backticks and a
  // part of a pipeline are shells of their own: they start with the `$!` of their parent and set none of it (`sleep 100 & ( coproc
  // sleep 101 ); echo $!` prints the pid of `sleep 100`). A `&` sets the `$!` of the shell that read it (`Segment.readScope`),
  // and the segment itself runs in a background shell of its own (`Segment.scope`). A segment with no words does the same for a
  // group, a subshell or a substitution that a `&` sent to the background, and for a process substitution that closed: it
  // stands where bash set `$!`, so nothing that follows it can move that to another shell.
  const bang = scopedCopy<{ last: Detached | undefined; saw: boolean }>({ last: undefined, saw: false })
  // `export` stays global on purpose: a subshell scope is not tracked for env, only for the directory. The shell variables
  // below follow the scope of the directory, so a variable set in a background list (`D=/x & srv $D/a.js &`) does not
  // reach the commands after the `&`, as in bash.
  const exported: Record<string, string> = {}
  // The shell variables the command sets, bare or with `export`, per subshell scope like the directory. They expand in a
  // detached command.
  const vars = scopedVars()
  const dirs = scopedDir(cwd)
  const opaque = substitutedNames(command)
  const setVar = (name: string, value: string, scope: string): void => {
    const v = opaque.has(name) ? '' : unmarkDollars(expandVars(value, n => vars.get(scope, n), dirs.get(scope)))
    // An empty value is no value: `D=$(mktemp -d)` reaches here as `D=` (the substitution is a subshell of its own).
    // `undefined` hides the value of an outer scope too.
    vars.set(scope, name, v === '' ? undefined : v)
  }

  for (const seg of splitShell(command)) {
    const shell = bang(seg.scope) // `$!` where the segment runs
    const reader = bang(seg.readScope) // `$!` where its `&` is read, and a job is set (the same as `shell` with no `&`)
    const jobBefore = shell.saw
    if (seg.bg) reader.saw = true
    // The marked words tell `'$F'` and `\$F` (as typed) from `$F` and `"$F"` (expanded). Only the variables read them.
    const pre = stripLead({ words: seg.marked, whole: seg.whole, redir: seg.redir })
    const ss = stripSetsid(pre.words)
    // `pre.words` is the end of `seg.marked` and `stripSetsid` drops from the front, so `ss.words` is the end too: its
    // flags are the end of `seg.whole` and `seg.redir`. `stripWrappers` reads them for the options of `time`.
    const from = seg.whole.length - ss.words.length
    const inner = stripWrappers(ss.words, seg.whole.slice(from), seg.redir.slice(from))
    const marked = inner.words
    const words = marked.map(unmarkDollars)
    const env = { ...exported, ...plainEnv(pre.env), ...plainEnv(inner.env) }
    if (words.length === 0) {
      // A line of assignments only (`L=/x`) sets shell variables. `L=/x cmd` sets them for `cmd` alone.
      if (pre.words.length === 0) for (const [k, v] of Object.entries(pre.env)) setVar(k, v, seg.scope)
      // `done &` backgrounds the whole loop: `$!` is then the pid of the loop shell, not of an earlier background command. A
      // segment with no words at all is the same: a `&` ended a group, a subshell or a substitution (`{ a; } &`, `x=$(a) &`,
      // `sleep $(a) &`, `( sleep 3 ) &`), or a process substitution closed (`cat <(a)`). `$!` names a shell or a process that has no
      // row, so no job before it may take the next pid line. It is set in the shell that read the `&`, where the segment stands.
      if (seg.bg) reader.last = NO_ROW
      continue
    }
    const head = words[0]!
    // `echo $! &` prints the pid of the job before it, so it keeps that job. Any other `&` job is a row (the detached
    // branch below replaces this) or no row: either way `$!` is no longer the job before it. An `echo $! > f &` is one of
    // them: it prints no line, and the `$!` after it is the pid of its own shell.
    if (seg.bg && !echoesPid(seg, words)) reader.last = NO_ROW
    // `coproc` runs its command as a job of its own and sets `$!`. The parser makes no row for it, so the pid line that an
    // `echo $!` after it prints is no earlier job's. It sets the `$!` of the shell that runs it, and of no shell above.
    if (head === 'coproc') {
      shell.last = NO_ROW
      shell.saw = true
    }

    if (head === 'cd' || head === 'pushd') {
      const target = words.slice(1).find(w => !w.startsWith('-'))
      dirs.set(seg.scope, target === undefined || target === '~' ? undefined : resolvePath(dirs.get(seg.scope), target))
      continue
    }
    if (head === 'export') {
      for (const w of marked.slice(1)) {
        const eq = w.indexOf('=')
        if (eq <= 0) continue
        exported[w.slice(0, eq)] = unmarkDollars(w.slice(eq + 1))
        setVar(w.slice(0, eq), w.slice(eq + 1), seg.scope)
      }
      continue
    }
    if (echoesPid(seg, words)) {
      if (jobBefore) {
        // The line names a row only for a job that `&` started (`NO_ROW` and a `setsid -f` job are `viaShell`), and only for the
        // first echo of it. A later echo prints the same line again, and keeps its place.
        const job = shell.last && !shell.last.viaShell && !claimed.has(shell.last) ? shell.last : undefined
        if (job) claimed.add(job)
        echoed.push(job)
      }
      continue
    }

    const docker = dockerCall(words)
    if (docker.kind === 'run') {
      const o = runOptions(docker.args)
      if (o.detach)
        runs.push({
          ...(o.name !== undefined ? { name: o.name } : {}),
          text: shortCmd(words.join(' ')),
          printed: keepsStdout(seg),
        })
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
      // The shell expands the variables before it runs the command, and `ps` shows the result.
      const pwd = dirs.get(seg.scope)
      const typed = marked.map(w => unmarkDollars(expandVars(w, n => vars.get(seg.scope, n), pwd))).join(' ')
      const d: Detached = { fingerprint: typed.slice(0, FINGERPRINT_MAX), viaShell: ss.fork && !seg.bg }
      detached.push(d)
      reader.last = d
    }
  }

  // A pid line is the pid of a job only when an `echo $!` printed it (issue #231, the owner's decision). The lines pair with the
  // echoes by position, and only when there is one line for each echo, as `pairContainerIds` does for the id lines. Any other
  // count means that a line is another command's, or that an echo's line is missing (a pipe may print it), so a line could slide
  // onto the next job: then no job of the call gets a pid, and the probe finds the rows by their fingerprint.
  if (echoed.length === pids.length)
    echoed.forEach((job, n) => {
      if (job) job.pid = pids[n]
    })

  // An id line is the id of a run only when the run printed it (issue #231): `pairContainerIds` holds the rule. A paired row is
  // exact (`containerIdExact`). Left over: the limits that the KB page process-tracking-signals lists under "The id of a
  // container" (a run that failed or did not run, a trailing `&`, a function called with a redirection). The test "container
  // id: known limits" pins them.
  const paired = pairContainerIds(
    containerIds(stdout),
    runs.map(r => r.printed),
  )
  runs.forEach((run, n) => {
    const containerId = paired[n]
    rows.push({
      id: `docker:ctr:${run.name ?? containerId ?? run.text}`,
      kind: 'docker-container',
      name: run.name ?? containerId?.slice(0, 12) ?? run.text,
      state: 'running',
      firstSeen: at,
      lastSeen: at,
      ...(containerId !== undefined ? { containerId, containerIdExact: true as const } : {}),
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

/**
 * The row of a Monitor. The third argument names it beyond its task: the Monitor call, its agent (absent for the main loop)
 * and the end-with-agent flag, as for a background task. The engine stops the Monitors of a workflow agent when the agent gives
 * its final response and sends no notice (issue #118). It does not stop those of a background subagent.
 */
export function monitorRow(
  taskId: string,
  at = Date.now(),
  { toolUseId, agentId, endsWithAgent = false }: BackgroundOf = {},
): ProcessRecord {
  return {
    id: `monitor:${taskId}`,
    kind: 'monitor',
    name: 'Monitor',
    state: 'running',
    firstSeen: at,
    lastSeen: at,
    taskId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(endsWithAgent ? { endsWithAgent: true as const } : {}),
  }
}

/** The id of the workflow agent that an `agent.spawn` started: its input has `workflow`. Undefined for any other agent. */
export function workflowAgentOf(input: unknown, answer: unknown): string | undefined {
  if (!isRecord(input) || !isRecord(input.workflow) || !isRecord(answer)) return undefined
  return str(answer.agentId)
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
 * How the `<event>` of a notice opens when a Monitor reaches its deadline (`timeout_ms`): `[Monitor expired after 1s
 * with no events delivered. Re-arm it ...]`. The engine kills the Monitor then, and this notice is the only one. It has no
 * `<status>` and no `<tool-use-id>` (issue #118). A line of the Monitor's own output has the same shape, so the opening
 * words are what tells the two apart. Both notices seen say `expired after Ns with no events delivered`. A Monitor that
 * delivered events first may say it another way, so the anchor is the shorter `[Monitor expired` (open question 40).
 */
const MONITOR_EXPIRED = '[Monitor expired'

/**
 * The same update from a notification row's text. The engine stores no `task` field on the row (in the types it
 * is a render prop only), so the text is the source: `<task-id>`, `<tool-use-id>`, `<status>`.
 * A Monitor that reached its deadline has no `<status>`: its event says so, and the row ends as `completed`. The deadline is
 * the bound the caller set, not a failure, so the row must not draw red like `killed` or `exited` (`sections.ts`).
 * The caller checks `origin.kind === 'task-notification'`: the person can type the same text.
 */
export function processUpdateFromNotificationText(text: string): TaskBackedUpdate | null {
  if (!text.includes('<task-notification>')) return null
  const expired = tag(text, 'event')?.startsWith(MONITOR_EXPIRED) === true
  return processUpdateFromNotification({
    id: tag(text, 'task-id'),
    toolUseId: tag(text, 'tool-use-id'),
    status: tag(text, 'status') ?? (expired ? 'completed' : undefined),
  })
}

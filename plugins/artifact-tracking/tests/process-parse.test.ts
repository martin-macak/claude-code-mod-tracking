import { expect, test } from 'claude-code/testing'
import {
  parseBashProcesses,
  processUpdateFromNotification,
  processUpdateFromNotificationText,
  processUpdateFromTaskStop,
} from '../trackers/processes/parse'
import {
  AGENT_RESUMED_NOTICE,
  MID_TURN_NOTICE,
  MONITOR_EVENT_NOTICE,
  MONITOR_EXPIRY_NOTICE,
  MONITOR_STREAM_ENDED_NOTICE,
} from './fixtures/notices'

test('parseBashProcesses tracks background Bash and Monitor-style task ids', () => {
  const rows = parseBashProcesses(
    'npm run dev',
    { result: { backgroundTaskId: 'task-1', backgroundedByUser: true, timedOutAfterMs: 30_000 } },
    { toolUseId: 'toolu_bg_1' },
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'background-task',
    taskId: 'task-1',
    toolUseId: 'toolu_bg_1',
    state: 'running',
  })
})

test('parseBashProcesses tracks docker, tmux, screen and detached pid launches', () => {
  // `docker run -d` prints the full 64-hex id.
  const full = 'a1b2c3d4e5f6'.repeat(5) + 'abcd'
  const docker = parseBashProcesses('docker run -d --name api nginx:latest', { result: { stdout: full + '\n' } })
  expect(docker[0]).toMatchObject({ kind: 'docker-container', name: 'api', containerId: full })

  const compose = parseBashProcesses('docker compose -p demo up -d', { result: { stdout: '' } })
  expect(compose[0]).toMatchObject({ kind: 'docker-compose', name: 'demo', state: 'running' })

  const tmux = parseBashProcesses('tmux new -d -s dev', { result: { stdout: '' } })
  expect(tmux[0]).toMatchObject({ kind: 'tmux', name: 'dev', state: 'running' })

  const screen = parseBashProcesses('screen -dmS watch npm run watch', { result: { stdout: '' } })
  expect(screen[0]).toMatchObject({ kind: 'screen', name: 'watch', state: 'running' })

  const detached = parseBashProcesses('nohup npm run dev > /tmp/dev.log 2>&1 & echo $!', {
    result: { stdout: '24567\n' },
  })
  expect(detached[0]).toMatchObject({
    kind: 'detached-process',
    pid: 24567,
    state: 'running',
    name: 'npm run dev',
    fingerprint: 'npm run dev',
  })
})

test('parseBashProcesses derives compose project from cwd when -p is missing', () => {
  const compose = parseBashProcesses('docker compose up -d', { result: { stdout: '' } }, { cwd: '/tmp/my-app' })
  expect(compose[0]).toMatchObject({
    kind: 'docker-compose',
    name: 'my-app',
    project: 'my-app',
    state: 'running',
  })
})

test('parseBashProcesses keeps a cd inside a subshell out of later commands', () => {
  const compose = parseBashProcesses(
    '(cd /srv/other && true); docker compose up -d',
    { result: { stdout: '' } },
    { cwd: '/work/app' },
  )
  expect(compose[0]).toMatchObject({ kind: 'docker-compose', name: 'app', project: 'app' })
})

test('task-notification and TaskStop updates map to process terminal states', () => {
  expect(processUpdateFromNotification({ id: 'task-1', status: 'completed' })).toEqual({
    taskId: 'task-1',
    state: 'completed',
  })
  expect(processUpdateFromNotification({ toolUseId: 'toolu_bg_1', status: 'failed' })).toEqual({
    toolUseId: 'toolu_bg_1',
    state: 'failed',
  })
  expect(processUpdateFromTaskStop({ task_id: 'task-1' })).toEqual({ taskId: 'task-1', state: 'killed' })
})

// ---------------------------------------------------------------- compound commands (PR #34 manual tests)

const ID_A = 'a'.repeat(12) + '0123456789abcdef'.repeat(3) + 'abcd'
const ID_B = 'b'.repeat(12) + '0123456789abcdef'.repeat(3) + 'abcd'
const out = (stdout: string) => ({ result: { stdout } })
const kinds = (rows: { kind: string }[]) => rows.map(r => r.kind)

test('compound: docker run -d after docker info is tracked by its --name (manual test 1)', () => {
  // docker info prints 12- and 40-hex commit ids. They must not become the container id.
  const stdout = 'Containerd fff62f14765df376e5fc36f5a8f8e795b5670f61\nInit 8181b32eea32\n' + ID_A + '\n'
  const rows = parseBashProcesses(
    "docker info --format '{{.ServerVersion}}'; docker run -d --name track-test-sleep alpine sleep 1800",
    out(stdout),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'docker-container', name: 'track-test-sleep', containerId: ID_A })
})

test('compound: hex noise without a docker run id line does not become the container id', () => {
  const rows = parseBashProcesses(
    'docker info; docker run -d --name api nginx',
    out('Containerd fff62f14765df376e5fc36f5a8f8e795b5670f61\n'),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'docker-container', name: 'api', id: 'docker:ctr:api' })
  expect(rows[0]?.containerId).toBeUndefined()
})

test('compound: docker compose up -d after mkdir -p and printf is tracked by -p (manual test 2)', () => {
  const rows = parseBashProcesses(
    "mkdir -p /tmp/tc && printf 'services:\\n  web:\\n    image: nginx; echo x\\n' > /tmp/tc/docker-compose.yml && docker compose -p track-compose -f /tmp/tc/docker-compose.yml up -d",
    out(''),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'docker-compose', name: 'track-compose', project: 'track-compose' })
})

test('compound: every shell separator reaches the docker run part', () => {
  for (const sep of [';', ' && ', ' || ', ' | ', '\n', ' & ']) {
    const rows = parseBashProcesses(`echo start${sep}docker run -d --name s1 alpine sleep 9`, out(ID_A + '\n'))
    expect(kinds(rows)).toEqual(['docker-container'])
    expect(rows[0]?.name).toBe('s1')
  }
})

test('compound: flags of another command do not leak into the docker or compose part', () => {
  // -d belongs to `ls`, -p belongs to `mkdir`: neither run is detached.
  expect(parseBashProcesses('ls -d . && docker run --rm alpine true', out(''))).toEqual([])
  expect(parseBashProcesses('mkdir -p x && docker compose up', out(''))).toEqual([])
  expect(
    parseBashProcesses('mkdir -p wrong && docker compose up -d', out(''), { at: 1, cwd: '/w/app' })[0],
  ).toMatchObject({
    project: 'app',
  })
})

test('compound: two detached runs get their own ids in order', () => {
  const rows = parseBashProcesses(
    'docker run -d --name a alpine sleep 9 && docker run -d --name b alpine sleep 9',
    out(`${ID_A}\n${ID_B}\n`),
  )
  expect(rows.map(r => [r.name, r.containerId])).toEqual([
    ['a', ID_A],
    ['b', ID_B],
  ])
})

// ---------------------------------------------------------------- docker run variants

test('docker run variants: subcommand forms, wrappers and combined short flags', () => {
  const cases = [
    'docker container run -d --name v alpine sleep 9',
    'docker run -dit --name v alpine sh',
    'docker run -itd --name v alpine sh',
    'docker run --detach --name v alpine sleep 9',
    'docker run --detach=true --name=v alpine sleep 9',
    'docker --context colima run -d --name v alpine sleep 9',
    'sudo docker run -d --name v alpine sleep 9',
    'env DOCKER_HOST=unix:///x docker run -d --name v alpine sleep 9',
    'DOCKER_HOST=unix:///x docker run -d --name v alpine sleep 9',
    'docker run -e A=1 -p 8080:80 -v /a:/b --rm -d --name v nginx',
  ]
  for (const c of cases) {
    const rows = parseBashProcesses(c, out(ID_A + '\n'))
    expect(rows.map(r => [r.kind, r.name])).toEqual([['docker-container', 'v']])
  }
})

test('docker run without detach, or with -d only inside the container command, is not tracked', () => {
  expect(parseBashProcesses('docker run --rm alpine ls -d /', out(''))).toEqual([])
  expect(parseBashProcesses('docker run -it alpine sh', out(''))).toEqual([])
  expect(parseBashProcesses('docker ps -a; docker logs -f api', out(''))).toEqual([])
  expect(parseBashProcesses('docker start -a api', out(''))).toEqual([])
})

test('docker run -d without --name: short id is the name, full id is kept', () => {
  const rows = parseBashProcesses('docker pull alpine && docker run -d alpine sleep 9', out(ID_A + '\n'))
  expect(rows[0]).toMatchObject({ id: `docker:ctr:${ID_A}`, name: ID_A.slice(0, 12), containerId: ID_A })
})

test('docker run -d without --name and without an id names the row by its own part only', () => {
  const rows = parseBashProcesses('cd /x && docker run -d alpine sleep 9', out(''))
  expect(rows[0]?.name).toBe('docker run -d alpine sleep 9')
})

// ---------------------------------------------------------------- compose variants

test('compose variants: detach forms and the standalone binary', () => {
  for (const c of [
    'docker compose -p p1 up --detach',
    'docker compose -p p1 up --wait',
    'docker compose -p p1 up -d --build',
    'docker-compose -p p1 up -d',
    'docker --context x compose -p p1 up -d',
    'docker compose --project-name=p1 up -d',
  ]) {
    const rows = parseBashProcesses(c, out(''))
    expect(rows.map(r => [r.kind, r.name])).toEqual([['docker-compose', 'p1']])
  }
})

test('compose project name: env, export, -f dir, --project-directory, cd and normalization', () => {
  const name = (c: string, cwd?: string) => parseBashProcesses(c, out(''), { at: 1, cwd })[0]?.project
  expect(name('COMPOSE_PROJECT_NAME=envp docker compose up -d')).toBe('envp')
  expect(name('export COMPOSE_PROJECT_NAME=expp; docker compose up -d')).toBe('expp')
  expect(name('docker compose -f /srv/stack/compose.yml up -d', '/w')).toBe('stack')
  expect(name('docker compose -f deploy/compose.yml up -d', '/w')).toBe('deploy')
  expect(name('docker compose -f compose.yml up -d', '/w/app')).toBe('app')
  expect(name('docker compose --project-directory /srv/pd up -d', '/w')).toBe('pd')
  expect(name('cd /srv/My.App && docker compose up -d', '/w')).toBe('myapp')
  expect(name('(cd sub && docker compose up -d)', '/w/root')).toBe('sub')
  expect(name('cd .. && docker compose up -d', '/w/root/sub')).toBe('root')
  expect(name('docker compose up -d', '/tmp/My App')).toBe('myapp')
  expect(name('docker compose -p Mixed_Case up -d')).toBe('mixed_case')
})

test('compose commands that start nothing detached are not tracked', () => {
  for (const c of [
    'docker compose up',
    'docker compose -p x down',
    'docker compose logs -f',
    'docker compose -p x ps',
    'docker compose run -d web',
  ])
    expect(parseBashProcesses(c, out(''))).toEqual([])
})

// ---------------------------------------------------------------- tmux and screen variants

test('tmux variants: new-session, combined flags, compound and normalized names', () => {
  const name = (c: string) => parseBashProcesses(c, out(''))[0]?.name
  expect(name('tmux new-session -d -s dev')).toBe('dev')
  expect(name('tmux new -ds dev')).toBe('dev')
  expect(name('tmux new -s dev -d')).toBe('dev')
  expect(name('tmux new -d -sdev')).toBe('dev')
  expect(name("tmux new-session -d -s dev -c /w 'npm run dev'")).toBe('dev')
  expect(name('tmux kill-server; tmux new -d -s x2')).toBe('x2')
  expect(name('tmux new -d -s a.b:c')).toBe('a_b_c')
})

test('tmux commands that are not a named detached session are not tracked', () => {
  expect(parseBashProcesses('tmux new -s fg', out(''))).toEqual([])
  expect(parseBashProcesses('tmux new -d', out(''))).toEqual([])
  expect(parseBashProcesses("tmux send-keys -t dev 'new -d -s z' Enter", out(''))).toEqual([])
  expect(parseBashProcesses('tmux ls', out(''))).toEqual([])
})

test('screen variants: split and reordered flags; -D -m (foreground) is not tracked', () => {
  const name = (c: string) => parseBashProcesses(c, out(''))[0]?.name
  expect(name('screen -d -m -S w npm run watch')).toBe('w')
  expect(name('screen -S w -dm npm run watch')).toBe('w')
  expect(name('screen -L -dmS w npm run watch')).toBe('w')
  expect(name('cd app && screen -dmS w npm start')).toBe('w')
  expect(parseBashProcesses('screen -Dm -S w npm start', out(''))).toEqual([])
  expect(parseBashProcesses('screen -ls', out(''))).toEqual([])
})

// ---------------------------------------------------------------- detached process variants

test('detached: plain cmd & echo $! is tracked (no nohup needed)', () => {
  const rows = parseBashProcesses('sleep 1800 & echo $!', out('4242\n'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'detached-process', pid: 4242, fingerprint: 'sleep 1800' })
})

test('detached: the fingerprint is the spawned program, without cd, env, nohup and redirections', () => {
  const fp = (c: string) => parseBashProcesses(c, out('4242\n'))[0]?.fingerprint
  expect(fp('cd app && nohup npm run dev > /tmp/dev.log 2>&1 & echo $!')).toBe('npm run dev')
  expect(fp('nohup env PORT=3000 node server.js >log 2>&1 &\necho $!')).toBe('node server.js')
  expect(fp('FOO=1 nohup python3 -m http.server 8000 & echo $!')).toBe('python3 -m http.server 8000')
  expect(fp('nohup ./serve --port 9 &> /tmp/s.log & echo "$!"')).toBe('./serve --port 9')
})

test('detached: setsid -f forks on its own; $! is not its pid, so the row has no pid', () => {
  const rows = parseBashProcesses('setsid -f node worker.js; echo $!', out('4242\n'), { toolUseId: 'toolu_s' })
  expect(rows.map(r => [r.fingerprint, r.pid])).toEqual([['node worker.js', undefined]])
  // Without -f, setsid stays in the foreground of a shell without job control.
  expect(parseBashProcesses('setsid node worker.js', out(''))).toEqual([])
})

test('detached: a foreground nohup is not a detached process, numbers in its output are not pids', () => {
  expect(parseBashProcesses('nohup ./build.sh', out('Built 123 files\n42\n'))).toEqual([])
  expect(parseBashProcesses('npm test 2>&1 | tail -5', out('12\n'))).toEqual([])
})

test('detached: the pid comes from a bare number line, not from other output', () => {
  const rows = parseBashProcesses('docker info; nohup sleep 9 > /dev/null 2>&1 & echo $!', out('Containers: 12\n777\n'))
  expect(rows.map(r => r.pid)).toEqual([777])
})

test('detached: two background jobs get their pids in order', () => {
  const rows = parseBashProcesses('sleep 101 & echo $!; sleep 102 & echo $!', out('101\n102\n'))
  expect(rows.map(r => [r.fingerprint, r.pid])).toEqual([
    ['sleep 101', 101],
    ['sleep 102', 102],
  ])
})

test('detached: without echo $! the row is kept without a pid, to be found by the probe', () => {
  const rows = parseBashProcesses('nohup sleep 100 > /dev/null 2>&1 &', out(''), { toolUseId: 'toolu_x', at: 5 })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'detached-process', id: 'bg:toolu_x:0', fingerprint: 'sleep 100' })
  expect(rows[0]?.pid).toBeUndefined()
})

// ---------------------------------------------------------------- quoting, nesting, heredocs, comments

test('quoted, nested, remote, heredoc and commented commands are not tracked', () => {
  for (const c of [
    'echo "a; docker run -d --name q x"',
    "bash -c 'docker run -d --name q x'",
    "ssh host 'tmux new -d -s r'",
    "cat > run.sh <<'EOF'\ndocker run -d --name h x\nnohup sleep 9 &\nEOF\nchmod +x run.sh",
    'cat <<-EOF > f\n\tdocker compose -p z up -d\n\tEOF',
    '# docker run -d --name c x\necho hi',
    'echo hi # && docker run -d --name c x',
  ])
    expect(parseBashProcesses(c, out(ID_A + '\n4242\n'))).toEqual([])
})

test('a heredoc does not hide the command after it', () => {
  const rows = parseBashProcesses("cat > /tmp/c.yml <<'EOF'\nservices: {}\nEOF\ndocker compose -p after up -d", out(''))
  expect(rows.map(r => r.name)).toEqual(['after'])
})

// ---------------------------------------------------------------- task notifications (manual test 1)

/** A real notification row's text (Claude Code 2.1.296). The engine stores no `task` field on the row. */
const NOTE = (status: string) =>
  '<task-notification>\n<task-id>bcsvumhut</task-id>\n<tool-use-id>toolu_01GfuArVsMsjZQPMycBmm7jG</tool-use-id>\n' +
  '<output-file>/private/tmp/claude-501/x/tasks/bcsvumhut.output</output-file>\n' +
  `<status>${status}</status>\n<summary>Background command "Sleep 90 seconds" ${status} (exit code 0)</summary>\n</task-notification>`

test('processUpdateFromNotificationText reads task id, tool use id and status from the row text', () => {
  expect(processUpdateFromNotificationText(NOTE('completed'))).toEqual({
    taskId: 'bcsvumhut',
    toolUseId: 'toolu_01GfuArVsMsjZQPMycBmm7jG',
    state: 'completed',
  })
  expect(processUpdateFromNotificationText(NOTE('failed'))?.state).toBe('failed')
  expect(processUpdateFromNotificationText(NOTE('killed'))?.state).toBe('killed')
})

test('processUpdateFromNotificationText ignores rows that are no terminal task notification', () => {
  expect(processUpdateFromNotificationText(NOTE('running'))).toBeNull()
  expect(processUpdateFromNotificationText('done, see <status>completed</status>')).toBeNull()
  expect(processUpdateFromNotificationText('')).toBeNull()
})

test('processUpdateFromNotificationText reads the notice inside the wrapper of a notice folded into a turn', () => {
  expect(processUpdateFromNotificationText(MID_TURN_NOTICE.text)).toEqual({
    taskId: 'butoa45ib',
    toolUseId: 'toolu_0167pQhp2xvXTrduu7Tmndwj',
    state: 'completed',
  })
  expect(processUpdateFromNotificationText(AGENT_RESUMED_NOTICE.text)?.taskId).toBe('brgzj6uhc')
})

test('processUpdateFromNotificationText reads the expiry of a Monitor, which has no status, as an end', () => {
  expect(processUpdateFromNotificationText(MONITOR_EXPIRY_NOTICE.text)).toEqual({
    taskId: 'bj0e6042y',
    state: 'completed',
  })
  // The notice of a source that ended has a status and a tool-use id, and no expiry words.
  expect(processUpdateFromNotificationText(MONITOR_STREAM_ENDED_NOTICE.text)).toEqual({
    taskId: 'bj0e6042y',
    toolUseId: 'toolu_01CtnZ5oNavyRd3PdEpn78pH',
    state: 'completed',
  })
})

test('a status of a Monitor notice wins over the expiry text', () => {
  // A notice with both: the expiry event and a status that is not `completed`. The status is the engine's own word.
  const both = MONITOR_EXPIRY_NOTICE.text.replace('<event>', '<status>failed</status>\n<event>')
  expect(processUpdateFromNotificationText(both)).toEqual({ taskId: 'bj0e6042y', state: 'failed' })
})

test('processUpdateFromNotificationText reads a Monitor that expired in other words as an end', () => {
  // Both notices seen so far say `[Monitor expired after Ns with no events delivered. ...]`. A Monitor that delivered an
  // event before its deadline may say it another way (open question 40). The words that open the event are the anchor.
  const other = MONITOR_EXPIRY_NOTICE.text.replace(
    '[Monitor expired after 1s with no events delivered.',
    '[Monitor expired at its deadline of 1s, 3 events delivered.',
  )
  expect(other).not.toBe(MONITOR_EXPIRY_NOTICE.text)
  expect(processUpdateFromNotificationText(other)).toEqual({ taskId: 'bj0e6042y', state: 'completed' })
})

test('processUpdateFromNotificationText does not read a Monitor event as an end', () => {
  expect(processUpdateFromNotificationText(MONITOR_EVENT_NOTICE.text)).toBeNull()
  // The words must open the event: a line of output that mentions them is an event.
  const mention = MONITOR_EXPIRY_NOTICE.text.replace('<event>[Monitor expired', '<event>log: [Monitor expired')
  expect(processUpdateFromNotificationText(mention)).toBeNull()
})

// ---------------------------------------------------------------- shell variables in a detached command (#56)

const detachedOf = (command: string, cwd?: string, stdout = '') =>
  parseBashProcesses(command, out(stdout), { toolUseId: 'toolu_v', at: 1, cwd }).filter(
    r => r.kind === 'detached-process',
  )

test('detached: a variable the command set is expanded in the name and the fingerprint', () => {
  // Case C of the issue. `$PWD` is the session cwd read before the call.
  const [c] = detachedOf('F=$PWD/srv.mjs; (nohup node $F > srv.log 2>&1 &); sleep 1', '/work')
  expect(c?.name).toBe('node /work/srv.mjs')
  expect(c?.fingerprint).toBe('node /work/srv.mjs')
  // The rows of the recorded session: `L` and `D` hold paths, the command reads them back.
  const [r] = detachedOf('L=/tmp/p/lab; D=/tmp/p/data\npython3 $L/bin/reader.py $D/big.txt &')
  expect(r?.fingerprint).toBe('python3 /tmp/p/lab/bin/reader.py /tmp/p/data/big.txt')
})

/** `${name}`, built so that no string of this file holds a template placeholder. */
const braced = (name: string) => ['$', '{', name, '}'].join('')

test('detached: export, braced names, a value that names an earlier variable and a cd before $PWD', () => {
  expect(detachedOf(`export L=/x; ${braced('L')}/run --port 80 &`)[0]?.fingerprint).toBe('/x/run --port 80')
  expect(detachedOf('A=/a; B=$A/b; srv $B &')[0]?.fingerprint).toBe('srv /a/b')
  expect(detachedOf('cd sub && (srv $PWD/app.js &)', '/w')[0]?.fingerprint).toBe('srv /w/sub/app.js')
  expect(detachedOf('A=/a; srv "x-$A-y" &')[0]?.fingerprint).toBe('srv x-/a-y')
})

test('detached: a variable with no known value stays as typed', () => {
  expect(detachedOf('node $UNSET &')[0]?.fingerprint).toBe('node $UNSET')
  // `$PWD` with no cwd is unknown. A value from a command substitution is not read: the reader sees `D=` and a subshell.
  expect(detachedOf('node $PWD/a.js &')[0]?.fingerprint).toBe('node $PWD/a.js')
  expect(detachedOf('D=$(mktemp -d); node $D/a.js &')[0]?.fingerprint).toBe('node $D/a.js')
  // A prefix assignment is not seen by the arguments of its own command.
  expect(detachedOf('F=/x node $F &')[0]?.fingerprint).toBe('node $F')
})

test('detached: a value with a command substitution is not read, whatever else the value holds', () => {
  // The shell splitter drops `$(...)` and backtick parts from a word, so `/tmp/run-$(date +%s)` would read as the
  // literal `/tmp/run-` and the probe would find no process (#56, AC5). The name stays a variable instead.
  const stays = 'node $D/s.js'
  expect(detachedOf('D=/tmp/run-$(date +%s); node $D/s.js &')[0]?.fingerprint).toBe(stays)
  expect(detachedOf('D=x$(echo 1)y; node $D/s.js &')[0]?.fingerprint).toBe(stays)
  expect(detachedOf('export D=/tmp/run-`date +%s`; node $D/s.js &')[0]?.fingerprint).toBe(stays)
  // `D=${X:-$(foo)}`, split so that no string of this file holds a template placeholder.
  expect(detachedOf(['D=$', '{X:-$(foo)}', '; node $D/s.js &'].join(''))[0]?.fingerprint).toBe(stays)
  // A later plain assignment does not undo it: the name is opaque in the whole command.
  expect(detachedOf('D=$(mktemp -d); D=/fixed; node $D/s.js &')[0]?.fingerprint).toBe(stays)
  // A substitution inside the quotes stays in the word, and a name other than the assigned one is no variable of ours.
  expect(detachedOf('echo "x=$(date)"; node $x/s.js &')[0]?.fingerprint).toBe('node $x/s.js')
  expect(detachedOf('E=/e; echo "d=$(date)"; node $E/s.js &')[0]?.fingerprint).toBe('node /e/s.js')
})

test('detached: a variable lives in the subshell that set it and in the ones below', () => {
  // The shell runs `node 1.js` and `node $L/s.js` with L unset (#56 review, m6).
  expect(detachedOf('X=1; (X=2; echo $X); node $X.js &')[0]?.fingerprint).toBe('node 1.js')
  expect(detachedOf('cd /a && (cd b; L=/y); node $L/s.js &')[0]?.fingerprint).toBe('node $L/s.js')
  // A child sees its parent's value, and its own value hides it.
  expect(detachedOf('A=/a; (srv $A/x &)')[0]?.fingerprint).toBe('srv /a/x')
  expect(detachedOf('A=/a; (A=/b; srv $A/x &)')[0]?.fingerprint).toBe('srv /b/x')
  // An unknown value in the child hides the parent's value too.
  expect(detachedOf('A=/a; (A=$(foo); srv $A/x &)')[0]?.fingerprint).toBe('srv $A/x')
  // A nested subshell reads the value of the one around it.
  expect(detachedOf('(A=/a; (srv $A/x &))')[0]?.fingerprint).toBe('srv /a/x')
})

test('detached: a reference in single quotes or after a backslash is literal, a bare or double-quoted one expands', () => {
  // The shell passes `'$F'` and `\$F` as typed, so `ps` shows `$F`. Expanding them would store a command no process has,
  // and the probe would mark the live process `exited` (#56 review).
  const set = 'F=/tmp/name; '
  expect(detachedOf(`${set}daemon '$F' &`)[0]?.fingerprint).toBe('daemon $F')
  expect(detachedOf(`${set}daemon \\$F &`)[0]?.fingerprint).toBe('daemon $F')
  expect(detachedOf(`${set}daemon "\\$F" &`)[0]?.fingerprint).toBe('daemon $F')
  expect(detachedOf(`${set}daemon "$F" &`)[0]?.fingerprint).toBe('daemon /tmp/name')
  expect(detachedOf(`${set}daemon $F &`)[0]?.fingerprint).toBe('daemon /tmp/name')
  // The quotes of the double quotes do not reach inside: `'` there is a plain character.
  expect(detachedOf(`${set}daemon "'$F'" &`)[0]?.fingerprint).toBe("daemon '/tmp/name'")
  // One word, several parts: only the quoted part stays literal.
  expect(detachedOf(`${set}daemon '$F'"$F"$F\\$F &`)[0]?.fingerprint).toBe('daemon $F/tmp/name/tmp/name$F')
  expect(detachedOf(`${set}daemon '${braced('F')}' &`)[0]?.fingerprint).toBe(`daemon ${braced('F')}`)
  expect(detachedOf(`${set}daemon ${braced('F')}/a &`)[0]?.fingerprint).toBe('daemon /tmp/name/a')
  // `$PWD` follows the same rule.
  expect(detachedOf("daemon '$PWD' $PWD &", '/w')[0]?.fingerprint).toBe('daemon $PWD /w')
})

test('detached: a literal reference in an assignment stays literal when the variable is read', () => {
  // `A='$B'` holds the text `$B`. The shell expands `$A` once and does not read the result again.
  expect(detachedOf("B=/b; A='$B'; srv $A &")[0]?.fingerprint).toBe('srv $B')
  expect(detachedOf("B=/b; export A='$B'; srv $A &")[0]?.fingerprint).toBe('srv $B')
  expect(detachedOf('B=/b; A=\\$B; srv $A &')[0]?.fingerprint).toBe('srv $B')
  // A reference in the value of a quoted assignment still expands.
  expect(detachedOf('B=/b; A="$B/x"; srv $A &')[0]?.fingerprint).toBe('srv /b/x')
})

test('detached: a literal dollar does not change the other words of a command', () => {
  // The words that `docker`, `tmux` and the rest read hold the plain `$`, never a mark of the reader.
  const rows = parseBashProcesses("docker run -d --name 'a$b' nginx", out(`${'ab'.repeat(32)}\n`), { at: 1 })
  expect(rows[0]).toMatchObject({ kind: 'docker-container', name: 'a$b' })
  expect(parseBashProcesses("tmux new -d -s 'x$y'", out(''), { at: 1 })[0]).toMatchObject({ kind: 'tmux', name: 'x$y' })
})

test('detached: a pid from echo $! is not a variable', () => {
  const [d] = parseBashProcesses('nohup sleep 5 > /dev/null 2>&1 & echo $!', out('4242\n'), {
    toolUseId: 'toolu_p',
    at: 1,
  })
  expect(d).toMatchObject({ pid: 4242, fingerprint: 'sleep 5' })
})

// ---------------------------------------------------------------- tasks that end with their agent (#56)

test('a background task of a subagent keeps the agent id and the end-with-agent flag', () => {
  const task = (extra: Record<string, unknown>, agentId?: string) =>
    parseBashProcesses(
      'sleep 15',
      { result: { backgroundTaskId: 't1', ...extra } },
      { toolUseId: 'toolu_1', at: 1, agentId },
    )[0]
  expect(task({ backgroundEndsWithFinalResponse: true }, 'a1')).toMatchObject({
    taskId: 't1',
    agentId: 'a1',
    endsWithAgent: true,
  })
  const survives = task({}, 'a1')
  expect(survives?.agentId).toBe('a1')
  expect(survives).not.toHaveProperty('endsWithAgent')
  // The engine sets the flag also for a headless main loop: the row has the flag and no agent.
  const headless = task({ backgroundEndsWithFinalResponse: true })
  expect(headless).toMatchObject({ endsWithAgent: true })
  expect(headless).not.toHaveProperty('agentId')
  // Only the real flag counts.
  expect(task({ backgroundEndsWithFinalResponse: 'yes' })).not.toHaveProperty('endsWithAgent')
})

// ---------------------------------------------------------------- shell loop keywords (#119)

const names = (command: string) => detachedOf(command).map(r => r.name)

test('loop: a for loop with a background command names the command, not do (issue #119 row 1)', () => {
  expect(names('for i in 1 2 3; do yes > /dev/null & done')).toEqual(['yes'])
})

test('loop: a variable set before the loop expands in the command after do (issue #119 row 2)', () => {
  expect(names('S=/tmp/s; for k in a b; do $S/loop.sh 200 $k & done')).toEqual(['/tmp/s/loop.sh 200 $k'])
})

test('loop: nohup after do is the nohup wrapper, as outside a loop (issue #119 row 3)', () => {
  expect(names('for k in a b; do nohup ./f104-loop.sh 200 $k > /tmp/l$k.log 2>&1 & done; sleep 1')).toEqual([
    './f104-loop.sh 200 $k',
  ])
})

test('loop: done with a background sign backgrounds the loop and makes no row (issue #119 row 4)', () => {
  expect(parseBashProcesses('for i in 1 2 3; do yes > /dev/null; done &', out(''))).toEqual([])
})

test('loop: a while loop in the background makes no row (issue #119 row 5)', () => {
  expect(parseBashProcesses('while true; do sleep 1; done &', out(''))).toEqual([])
})

test('if: a background command after then names the command, not then (issue #119 row 6)', () => {
  expect(names('if true; then sleep 100 & fi')).toEqual(['sleep 100'])
})

test('loop: fi and esac with a background sign background the whole block and make no row', () => {
  expect(parseBashProcesses('if true; then sleep 1; fi &', out(''))).toEqual([])
  expect(parseBashProcesses('case $x in a) sleep 1;; esac &', out(''))).toEqual([])
})

// `$!` is the pid of the last background job. After `done &` that is the loop shell, so it is not the pid of the
// command that started before the loop (Codex review of the PR).
test('loop: echo $! after a backgrounded loop does not give its pid to the earlier background command', () => {
  const [row] = detachedOf('sleep 100 & for i in 1; do :; done & echo $!', undefined, '555\n')
  expect(row).toMatchObject({ name: 'sleep 100' })
  expect(row).not.toHaveProperty('pid')
})

test('loop: echo $! after a foreground loop still gives the pid to the background command', () => {
  const [row] = detachedOf('for i in 1; do sleep 100 & done; echo $!', undefined, '555\n')
  expect(row).toMatchObject({ name: 'sleep 100', pid: 555 })
})

// A backgrounded builtin runs in a shell of its own, so `$!` after it is that shell's pid, not the job before it (issue
// #132). Only the next background job gets a pid from `$!`.
test('builtin: echo $! after a backgrounded builtin does not give its pid to the earlier background command', () => {
  for (const cmd of ['sleep 100 & echo x & echo $!', 'sleep 100 & printf x & echo $!']) {
    const [row] = detachedOf(cmd, undefined, '4242\n')
    expect({ cmd, row: row?.name }).toEqual({ cmd, row: 'sleep 100' })
    expect({ cmd, pid: row?.pid }).toEqual({ cmd, pid: undefined })
  }
})

test('builtin: a background job after a backgrounded builtin still gets the pid from echo $!', () => {
  const rows = detachedOf('sleep 100 & echo x & sleep 101 & echo $!', undefined, '4242\n')
  expect(rows.map(r => [r.name, r.pid])).toEqual([
    ['sleep 100', undefined],
    ['sleep 101', 4242],
  ])
})

// The `$!` line of a backgrounded builtin is in stdout too. `echo $!` takes it off the list, so the next background job
// gets its own pid (review of the PR, M1).
test('builtin: the $! line of a backgrounded builtin is not the pid of the next background job', () => {
  const rows = detachedOf('sleep 100 & echo x & echo $!; sleep 101 & echo $!', undefined, '4242\n4243\n')
  expect(rows.map(r => [r.name, r.pid])).toEqual([
    ['sleep 100', undefined],
    ['sleep 101', 4243],
  ])
})

// `cd`, `pushd`, `export`, docker, and a tmux or screen session start take their own branch in the parser, before the
// detached branch. A backgrounded one makes no detached row and has a shell of its own, as `echo x &` has.
test('builtin: a backgrounded cd, pushd, export, docker, tmux or screen start gives no pid to the earlier background command', () => {
  for (const bg of [
    'cd /tmp',
    'pushd /tmp',
    'export X=1',
    'docker ps',
    'docker run -d nginx',
    'tmux new -d -s x',
    'screen -dmS x',
  ]) {
    const cmd = `sleep 100 & ${bg} & echo $!`
    const rows = detachedOf(cmd, undefined, '4242\n')
    expect({ cmd, rows: rows.map(r => [r.name, r.pid]) }).toEqual({ cmd, rows: [['sleep 100', undefined]] })
  }
})

// A cd that runs in the background (`cd /x & ...`, or a list that ends with `&`) does not move the folder of the later
// commands (issue #141): the compose project and the $PWD of a detached command stay the session's.
const composeProject = (command: string) =>
  parseBashProcesses(command, out(''), { cwd: '/work/app' }).find(r => r.kind === 'docker-compose')?.project

test('parseBashProcesses keeps the session folder after a cd that runs in the background', () => {
  const project = composeProject
  expect(project('cd /x && docker compose up -d')).toBe('x')
  expect(project('cd /x || docker compose up -d')).toBe('x')
  expect(project('cd /x & docker compose up -d')).toBe('app')
  expect(project('cd /x && true & docker compose up -d')).toBe('app')
  expect(project('{ cd /x; } & docker compose up -d')).toBe('app')
  expect(project('pushd /x & docker compose up -d')).toBe('app')
  expect(project('for d in a; do cd /x & docker compose up -d; done')).toBe('app')
  expect(detachedOf('cd /x & srv $PWD/app.js &', '/w')[0]?.fingerprint).toBe('srv /w/app.js')
})

// A `{` group opens a list of its own: an `&` inside it does not background the `cd` before the group.
test('parseBashProcesses keeps a cd before a group that holds a background job', () => {
  expect(composeProject('cd /x && { npm start & }; docker compose up -d')).toBe('x')
  expect(composeProject('cd /x && { npm start & docker compose up -d; }')).toBe('x')
  expect(composeProject('cd /x && { ( cd /y ) & }; docker compose up -d')).toBe('x')
  expect(composeProject('cd /x && { true; } && npm start & docker compose up -d')).toBe('app')
})

// A newline right after `&&`, `||` or `|` continues the list, as in bash.
test('parseBashProcesses keeps the session folder after a cd in a list that continues on the next line', () => {
  expect(composeProject('cd /x &&\nsleep 1 &\ndocker compose up -d')).toBe('app')
  expect(composeProject('cd /x ||\n\n# note\nsleep 1 &\ndocker compose up -d')).toBe('app')
  expect(composeProject('cd /x |\nsleep 1 &\ndocker compose up -d')).toBe('app')
  expect(composeProject('cd /x && true\nsleep 1 &\ndocker compose up -d')).toBe('x')
})

// A `for`, `while`, `until`, `if`, `case` or `select` that ends with `&` runs in the background as a whole.
test('parseBashProcesses keeps the session folder after a cd in a loop that runs in the background', () => {
  expect(composeProject('for d in a; do cd /x; done & docker compose up -d')).toBe('app')
  expect(composeProject('while true; do cd /x; sleep 1; done & docker compose up -d')).toBe('app')
  expect(composeProject('until false; do cd /x; break; done & docker compose up -d')).toBe('app')
  expect(composeProject('if true; then cd /x; fi & docker compose up -d')).toBe('app')
  expect(composeProject('case x in x) cd /x ;; esac & docker compose up -d')).toBe('app')
  expect(composeProject('select d in a; do cd /x; break; done & docker compose up -d')).toBe('app')
  // `time [-p]` can stand in front of a compound. The loop after it runs in the background as a whole, and its `done`
  // does not close the compound around it.
  expect(composeProject('time -p for d in a; do cd /x; done & docker compose up -d')).toBe('app')
  expect(composeProject('if true; then cd /x; time for i in 1; do :; done & docker compose up -d; fi')).toBe('x')
  expect(composeProject('for d in a; do for e in b; do cd /x; done; done & docker compose up -d')).toBe('app')
  expect(composeProject('cd /x && for d in a; do :; done & docker compose up -d')).toBe('app')
  expect(composeProject('for d in a; do cd /x; done; docker compose up -d')).toBe('x')
  expect(composeProject('if true; then cd /x; fi && docker compose up -d')).toBe('x')
})

// Bash runs each part of a pipeline in a subshell, the last part too (no `lastpipe`). A `cd` in a part does not move the
// folder of the commands after the pipeline (issue #147). A `cd` outside a pipeline still moves it.
test('parseBashProcesses keeps the session folder after a cd in a pipeline part', () => {
  const project = composeProject
  expect(project('cd /x | cat; docker compose up -d')).toBe('app')
  expect(project('cat f | cd /x; docker compose up -d')).toBe('app')
  expect(project('cd /x |& cat; docker compose up -d')).toBe('app')
  expect(project('echo a | cd /x | cat; docker compose up -d')).toBe('app')
  expect(project('! cd /x | cat; docker compose up -d')).toBe('app')
  expect(project('cd /x |\ncat\ndocker compose up -d')).toBe('app')
})

// A part is a whole command: a group, a loop or a subshell. The pipeline ends at the closing bracket of a group
// or a subshell, and the parts run side by side.
test('parseBashProcesses keeps the session folder after a cd in a group, a loop or a subshell that is a pipeline part', () => {
  const project = composeProject
  expect(project('{ cd /x; } | cat; docker compose up -d')).toBe('app')
  expect(project('for d in a; do cd /x; done | cat; docker compose up -d')).toBe('app')
  expect(project('cat f | while read l; do cd /x; done; docker compose up -d')).toBe('app')
  expect(project('( cd /x ) | cat; docker compose up -d')).toBe('app')
  expect(project('if cd /x | cat; then docker compose up -d; fi')).toBe('app')
  // Inside a group or a subshell the pipeline ends at the closing bracket.
  expect(project('(cd /x | cat); docker compose up -d')).toBe('app')
  expect(project('{ cat | cd /x; docker compose up -d; }')).toBe('app')
  // The parts run side by side: a cd in one part does not reach the next. In a group part, it does reach the commands
  // after it in the same part.
  expect(project('cd /x | docker compose up -d')).toBe('app')
  expect(project('cat | { cd /x; docker compose up -d; }')).toBe('x')
})

// A `cd` outside a pipeline still moves the folder, and a part reads the folder it starts in.
test('parseBashProcesses moves the folder for a cd outside a pipeline', () => {
  const project = composeProject
  expect(project('cd /x; docker compose up -d')).toBe('x')
  expect(project('cd /x && cat | cat; docker compose up -d')).toBe('x')
  expect(project('cat | cat; cd /x; docker compose up -d')).toBe('x')
  expect(project('cd /x && docker compose up -d | cat')).toBe('x')
})

// `>|` is a redirection, no pipe: its `cd` is no pipeline part.
test('parseBashProcesses reads >| as a redirection, not a pipe', () => {
  const project = composeProject
  expect(project('cd /x >| f; docker compose up -d')).toBe('x')
  expect(project('cd /x 2>| f; docker compose up -d')).toBe('x')
  expect(project("cd /x; echo '>'| cat; docker compose up -d")).toBe('x')
  expect(project("echo '>'| cd /x; docker compose up -d")).toBe('app')
  // An escaped `>` is a word, so the `|` after it is a pipe. After an escaped backslash the `>` is typed again.
  expect(project('printf x \\>|docker compose up -d')).toBe('app')
  expect(project('printf x \\>| docker compose up -d')).toBe('app')
  expect(project('printf x \\\\>| docker compose up -d')).toBeUndefined()
})

// The `$PWD` of a detached command, and a shell variable, follow the same scope.
test('parseBashProcesses keeps the scope of $PWD and a shell variable after a pipeline part', () => {
  expect(detachedOf('cd /x | cat; srv $PWD/app.js &', '/w')[0]?.fingerprint).toBe('srv /w/app.js')
  expect(detachedOf('D=/x | cat; srv $D/a.js &', '/w')[0]?.fingerprint).toBe('srv $D/a.js')
  expect(detachedOf('D=/x; cat | srv $D/a.js &', '/w')[0]?.fingerprint).toBe('srv /x/a.js')
})

// The `)` that ends a `case` pattern is no end of a subshell (issue #148). A `cd` in the arm of a case in a subshell stays
// in that subshell.
test('parseBashProcesses keeps the session folder after a cd in a case arm inside a subshell', () => {
  const project = composeProject
  expect(project('( case x in x) cd /x ;; esac ); docker compose up -d')).toBe('app')
  expect(project('( case x in y) :;; x) cd /x ;; esac ); docker compose up -d')).toBe('app')
  expect(project('( case x in a|x) cd /x ;; esac ); docker compose up -d')).toBe('app')
  expect(project('( case x in\n x) cd /x ;;\n esac\n ); docker compose up -d')).toBe('app')
  expect(project('( case x in x) cd /x ;& y) cd /y ;;& z) cd /z ;; esac ); docker compose up -d')).toBe('app')
  expect(project('( case $(echo x) in x) cd /x ;; esac ); docker compose up -d')).toBe('app')
  expect(project('( case x in (x) cd /x ;; esac ); docker compose up -d')).toBe('app')
  expect(project('x=$(case a in a) cd /x ;; esac); docker compose up -d')).toBe('app')
})

// A `case` in a case, and a subshell or a substitution in an arm: each closes at its own `)`.
test('parseBashProcesses keeps the session folder after a cd in a case in a case or in a subshell in an arm', () => {
  const project = composeProject
  expect(project('( case x in x) case y in y) cd /x ;; esac; cd /z ;; esac ); docker compose up -d')).toBe('app')
  // A subshell in an arm closes at its own `)`, and so does a substitution in a pattern or in an arm.
  expect(project('case x in x) (cd /y); docker compose up -d ;; esac')).toBe('app')
  expect(project('( case x in x) ( cd /y ) ;; esac ); docker compose up -d')).toBe('app')
  expect(project('( case x in x) echo $(cd /y) ;; esac ); docker compose up -d')).toBe('app')
  expect(project('( case x in $(echo x)) cd /x ;; esac ); docker compose up -d')).toBe('app')
})

// `esac` ends the case, so the `)` of a subshell after it closes that subshell. Outside a subshell the arm is no
// subshell.
test('parseBashProcesses closes the subshell after esac and moves the folder for a case outside a subshell', () => {
  const project = composeProject
  expect(project('case x in x) : ;; esac; ( cd /x ); docker compose up -d')).toBe('app')
  expect(project('( case x in x) cd /x ;; esac; docker compose up -d )')).toBe('x')
  // Outside a subshell the arm is no subshell: its cd moves the folder, as before.
  expect(project('case x in x) cd /x ;; esac; docker compose up -d')).toBe('x')
  expect(project('case x in y) cd /y ;; x) cd /x ;; esac; docker compose up -d')).toBe('x')
})

// A `(` in front of a pattern (after `in` or after `;;`) is no subshell. A `(` after a pattern is one.
test('parseBashProcesses reads a ( in front of a case pattern as no subshell', () => {
  const project = composeProject
  expect(project('( case x in (x) cd /x ;; (y|z) cd /y ;; esac ); docker compose up -d')).toBe('app')
  expect(project('case x in\n (x) cd /x ;;\n (y) : ;;\n esac; docker compose up -d')).toBe('x')
  expect(project('case x in x) ( cd /y ) ;; (z) ( cd /z ) ;; esac; docker compose up -d')).toBe('app')
  expect(project('cd /x && case y in (y) sleep 1 & esac; docker compose up -d')).toBe('x')
})

// The arm after a pattern is a list of its own. A case that ends with `&` or `|` is one background job or
// pipeline part.
test('parseBashProcesses keeps the arm after a pattern a list of its own and ends a case at & or |', () => {
  const project = composeProject
  expect(project('cd /x && case x in x) sleep 1 & esac; docker compose up -d')).toBe('x')
  expect(project('{ cd /x && case x in a|x) sleep 1 &\n true ;;& z) : ;; esac; }; docker compose up -d')).toBe('x')
  expect(project('case x in x) cd /y & ;; esac; docker compose up -d')).toBe('app')
  // A case that ends with `&` or `|` is one background job or pipeline part.
  expect(project('( case x in x) cd /x ;; esac & ); docker compose up -d')).toBe('app')
  expect(project('case x in x) cd /x ;; esac | cat; docker compose up -d')).toBe('app')
})

// `esac` can stand right after a compound with no `;;`: `a | { b; } esac`, `fi esac`, `done esac`. It still ends the
// case, and the compound before it still ends its pipeline part.
test('parseBashProcesses ends the case and the pipeline at an esac that follows a compound', () => {
  const project = composeProject
  expect(project('case x in x) echo hi | { cd /x; } esac; docker compose up -d')).toBe('app')
  expect(project('( case x in x) if :; then cd /x; fi esac ); docker compose up -d')).toBe('app')
  expect(project('( case x in x) for i in 1; do cd /x; done esac ); docker compose up -d')).toBe('app')
})

// Only the `in` of the case header makes a `(` a pattern start. A word `in` at the end of a line of an arm does not.
test('parseBashProcesses reads a ( after a line that ends with the word in as a subshell', () => {
  expect(composeProject('case x in x) echo logged in\n( cd /y ); docker compose up -d ;; esac')).toBe('app')
})

// A pipeline part ends where bash ends it: at a background `&`, at the close of a subshell, a substitution or a group.
test('parseBashProcesses ends a pipeline part at a background &, a subshell, a substitution and a group', () => {
  const project = composeProject
  expect(project('cat | cd /x & cd /y; docker compose up -d')).toBe('y')
  expect(project('cat | ( cd /x; docker compose up -d ); true')).toBe('x')
  expect(project('cat | ( cd /x; true ); docker compose up -d')).toBe('app')
  expect(project('cat | cd $(echo /x); docker compose up -d')).toBe('app')
  expect(project('{ cat | { cd /x; } }; docker compose up -d')).toBe('app')
})

// The variables follow the scope of the directory: a variable set in a background list does not reach the commands
// after the `&`, as in bash. `export` keeps the env global.
test('parseBashProcesses hides a variable set in a background list from the commands after the `&`', () => {
  expect(detachedOf('D=/x & srv $D/a.js &', '/w')[0]?.fingerprint).toBe('srv $D/a.js')
  expect(detachedOf('D=/x; srv $D/a.js &', '/w')[0]?.fingerprint).toBe('srv /x/a.js')
})

test('loop: the $! line of a backgrounded loop is not the pid of the next background job', () => {
  const rows = detachedOf(
    'sleep 100 & for i in 1; do :; done & echo $!; sleep 101 & echo $!',
    undefined,
    '4242\n4243\n',
  )
  expect(rows.map(r => [r.name, r.pid])).toEqual([
    ['sleep 100', undefined],
    ['sleep 101', 4243],
  ])
})

// `echo $! &` prints the pid of the job before it, so it does not clear that job.
test('builtin: a backgrounded echo $! after a background job still gives it its pid', () => {
  const [row] = detachedOf('sleep 100 & echo $! & echo $!', undefined, '4242\n4243\n')
  expect(row).toMatchObject({ name: 'sleep 100', pid: 4242 })
})

test('if: a background command after ! and time names the command, in either order', () => {
  expect(names('time ! sleep 10 &')).toEqual(['sleep 10'])
  expect(names('! time sleep 10 &')).toEqual(['sleep 10'])
  expect(names('if time ! sleep 10 & then :; fi')).toEqual(['sleep 10'])
})

test('if: a background command after else names the command', () => {
  expect(names('if false; then true; else sleep 5 & fi')).toEqual(['sleep 5'])
})

test('if: a background command after elif names the command', () => {
  expect(names('if false; elif yes & then :; fi')).toEqual(['yes'])
})

test('loop: a background command after if, while or until names the command', () => {
  expect(names('if yes & then :; fi')).toEqual(['yes'])
  expect(names('while yes & do :; done')).toEqual(['yes'])
  expect(names('until yes & do :; done')).toEqual(['yes'])
})

test('loop: a subshell around a loop names the command (issue #119 row 7)', () => {
  expect(names('(for i in 1 2 3; do yes >/dev/null & done)')).toEqual(['yes'])
})

test('loop: a brace group around a loop names the command', () => {
  expect(names('{ for i in 1 2 3; do yes > /dev/null & done; }')).toEqual(['yes'])
})

// Every detector reads the command after `do`, `then`, `else`, `elif`, `if`, `while` and `until`, not only the
// detached-process one. The row of a loop stands for every pass, so a name with `$i` keeps the literal text.
test('loop: a docker container after do or if is read as outside a loop', () => {
  expect(parseBashProcesses('for i in 1 2; do docker run -d --name x$i img; done', out(''))[0]).toMatchObject({
    kind: 'docker-container',
  })
  expect(parseBashProcesses('if docker run -d --name x img; then :; fi', out(''))[0]).toMatchObject({
    kind: 'docker-container',
    name: 'x',
  })
})

test('loop: docker compose after do is read as outside a loop', () => {
  expect(parseBashProcesses('for d in a b; do docker compose -p demo up -d; done', out(''))[0]).toMatchObject({
    kind: 'docker-compose',
    name: 'demo',
  })
})

test('if: tmux after then is read as outside a loop', () => {
  expect(parseBashProcesses('if ! tmux has-session -t dev; then tmux new -d -s dev; fi', out(''))[0]).toMatchObject({
    kind: 'tmux',
    name: 'dev',
  })
})

test('loop: screen after do is read as outside a loop', () => {
  expect(parseBashProcesses('for d in a b; do screen -dmS w$d sleep 100; done', out(''))[0]).toMatchObject({
    kind: 'screen',
  })
})

test('loop: setsid -f after do is read as outside a loop', () => {
  expect(names('for i in 1 2; do setsid -f sleep 100; done')).toEqual(['sleep 100'])
})

// Branches are not tracked: the last write wins, as with `&&` and `||`.
test('if: a variable set in then and else takes the last write', () => {
  expect(detachedOf('if true; then A=/one; else A=/two; fi; srv $A &')[0]?.fingerprint).toBe('srv /two')
  expect(detachedOf('[ -n x ] && A=/one || A=/two; srv $A &')[0]?.fingerprint).toBe('srv /two')
})

test('loop: a builtin after do ends with the shell and makes no row', () => {
  expect(parseBashProcesses('for i in 1 2; do echo x & done', out(''))).toEqual([])
})

test('loop: the multi-line form still names the command (guard)', () => {
  expect(names('for i in 1 2 3; do\n  yes > /dev/null &\ndone')).toEqual(['yes'])
})

// A `}` right before a closing backtick ends its group (issue #161). Else the group stays open and the later `}` closes
// the wrong place, so the `&` leaves the `cd` in front of the backtick out of the background list.
test('parseBashProcesses ends a group at a } right before a closing backtick', () => {
  const project = composeProject
  const projects = (cmd: string) =>
    parseBashProcesses(cmd, out(''), { cwd: '/work/app' })
      .filter(r => r.kind === 'docker-compose')
      .map(r => r.project)
  expect(projects('{ echo `cd /x; { docker compose up -d; }`; } & docker compose up -d')).toEqual(['x', 'app'])
  expect(project('{ cd /y; echo `{ :; }`; } & docker compose up -d')).toBe('app')
  expect(project('cd /y && echo `{ :; }` & docker compose up -d')).toBe('app')
  // Without the `&` the group ends in the same shell, so the `cd` still moves the folder.
  expect(project('{ cd /y; echo `{ :; }`; }; docker compose up -d')).toBe('y')
})

// Only a `>` that was typed, with no quote and no backslash, is a redirection (issue #162). A quoted or escaped one is a
// word, and so is the word after it. The `&` after it is a background operator.
test('parseBashProcesses reads a quoted or escaped > as a word', () => {
  expect(detachedOf('nohup node srv.js \\> out.txt &')[0]?.name).toBe('node srv.js > out.txt')
  expect(detachedOf("nohup node srv.js '>' out.txt &")[0]?.name).toBe('node srv.js > out.txt')
  expect(detachedOf('nohup node srv.js ">>" log &')[0]?.name).toBe('node srv.js >> log')
  expect(composeProject("echo '>'& cd /x; docker compose up -d")).toBe('x')
  expect(composeProject('echo a \\>& cd /x; docker compose up -d')).toBe('x')
  // A typed redirection is no word, and a quoted or escaped target belongs to it.
  expect(detachedOf('nohup node srv.js > out.txt &')[0]?.name).toBe('node srv.js')
  expect(detachedOf('nohup node srv.js >out.txt 2>&1 &')[0]?.name).toBe('node srv.js')
  expect(detachedOf("nohup node srv.js > '>' 2>&1 &")[0]?.name).toBe('node srv.js')
  expect(detachedOf('nohup node srv.js >\\> -v &')[0]?.name).toBe('node srv.js -v')
})

// A case pattern is never a command (issue #163): `cd)` moves no folder, and `if)`, `for)` or `done)` open or close no
// compound.
test('parseBashProcesses reads a case pattern as no command', () => {
  const project = composeProject
  expect(project('case x in y) :;; cd) :;; esac; docker compose up -d')).toBe('app')
  expect(project('case x in a|cd) :;; (cd|c) :;; esac; docker compose up -d')).toBe('app')
  expect(project('case x in\n cd) :;;\n esac; docker compose up -d')).toBe('app')
  expect(project('case $(echo x) in cd) :;; esac; docker compose up -d')).toBe('app')
  // No white space between `in` or `;;` and the `(` in front of a pattern.
  expect(project('( case x in(x) cd /x ;;(y) cd /y ;; esac ); docker compose up -d')).toBe('app')
  // A pattern keyword opens or closes no compound: the case stays one unit, and the arm that matches keeps its subshell.
  expect(project('( case x in if) :;; for|done) :;; (fi) :;; x) cd /x ;; esac ); docker compose up -d')).toBe('app')
  expect(project('case x in if) :;; while|done) cd /y ;; esac & docker compose up -d')).toBe('app')
  expect(project('for i in 1; do case x in done) cd /y ;; esac; done & docker compose up -d')).toBe('app')
  // `esac` first in the pattern position ends the case. Behind `|` or `(` it is a pattern.
  expect(project('case x in\nesac; cd /x; docker compose up -d')).toBe('x')
  expect(project('( case x in a|esac) cd /x ;; (esac) :;; esac ); docker compose up -d')).toBe('app')
  // A quoted or escaped `esac` is a pattern in every position: it ends no case and no subshell around it.
  expect(project("( case x in 'esac') cd /x ;; esac ); docker compose up -d")).toBe('app')
  expect(project('( case x in "esac"|\\esac) cd /x ;; esac ); docker compose up -d')).toBe('app')
  expect(project("case x in 'esac') cd /x ;; esac & docker compose up -d")).toBe('app')
  // An empty quote makes it a pattern too.
  expect(project("case x in esac'') cd /x ;; esac & docker compose up -d")).toBe('app')
  // A command named `case`, quoted or escaped, opens no case: the commands after it are no pattern words.
  expect(project("'case' x in; docker compose up -d")).toBe('app')
  expect(project('\\case x in; cd /y; docker compose up -d')).toBe('y')
})

// A compound at the start of a condition opens a level of its own (issue #163): the `done` of `if for ...; done; then`
// closes the `for`, and the `fi` closes the `if`. So the `&` after the `fi` backgrounds the whole `if`.
test('parseBashProcesses opens a compound of its own at the start of a condition', () => {
  const project = composeProject
  expect(project('if for i in 1; do :; done; then cd /x; fi & docker compose up -d')).toBe('app')
  expect(project('while for i in 1; do :; done; do cd /x; break; done & docker compose up -d')).toBe('app')
  expect(project('if if :; then :; fi; then cd /x; fi & docker compose up -d')).toBe('app')
  expect(project('if :; then :; elif for i in 1; do :; done; then cd /x; fi & docker compose up -d')).toBe('app')
  expect(project('if case x in x) :;; esac; then cd /x; fi | cat; docker compose up -d')).toBe('app')
  expect(project('until if :; then :; fi; do cd /x; break; done & docker compose up -d')).toBe('app')
  expect(project('if ! time for i in 1; do :; done; then cd /x; fi & docker compose up -d')).toBe('app')
  // A foreground `if` still moves the folder.
  expect(project('if for i in 1; do :; done; then cd /x; fi; docker compose up -d')).toBe('x')
})

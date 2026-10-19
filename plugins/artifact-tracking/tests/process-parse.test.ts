import { expect, test } from 'claude-code/testing'
import {
  parseBashProcesses,
  processUpdateFromNotification,
  processUpdateFromNotificationText,
  processUpdateFromTaskStop,
} from '../trackers/processes/parse'

test('parseBashProcesses tracks background Bash and Monitor-style task ids', () => {
  const rows = parseBashProcesses(
    'npm run dev',
    { result: { backgroundTaskId: 'task-1', backgroundedByUser: true, timedOutAfterMs: 30_000 } },
    'toolu_bg_1',
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
  const compose = parseBashProcesses(
    'docker compose up -d',
    { result: { stdout: '' } },
    undefined,
    Date.now(),
    '/tmp/my-app',
  )
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
    undefined,
    Date.now(),
    '/work/app',
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
    parseBashProcesses('mkdir -p wrong && docker compose up -d', out(''), undefined, 1, '/w/app')[0],
  ).toMatchObject({ project: 'app' })
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
  const name = (c: string, cwd?: string) => parseBashProcesses(c, out(''), undefined, 1, cwd)[0]?.project
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
  const rows = parseBashProcesses('setsid -f node worker.js; echo $!', out('4242\n'), 'toolu_s')
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
  const rows = parseBashProcesses('nohup sleep 100 > /dev/null 2>&1 &', out(''), 'toolu_x', 5)
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

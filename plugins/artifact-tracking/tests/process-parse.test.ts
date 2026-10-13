import { expect, test } from 'claude-code/testing'
import { parseBashProcesses, processUpdateFromNotification, processUpdateFromTaskStop } from '../hooks/process/parse'

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
  const docker = parseBashProcesses('docker run -d --name api nginx:latest', { result: { stdout: 'a1b2c3d4e5f6\n' } })
  expect(docker[0]).toMatchObject({ kind: 'docker-container', name: 'api', containerId: 'a1b2c3d4e5f6' })

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

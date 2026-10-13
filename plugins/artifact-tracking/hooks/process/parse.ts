import type { ProcessRecord, ProcessState } from '../contracts'
import { isRecord } from '../json'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const TASK_DONE: Record<string, ProcessState> = { completed: 'completed', failed: 'failed', killed: 'killed' }

const toWords = (command: string): string[] => command.trim().split(/\s+/).filter(Boolean)

function hasFlag(words: readonly string[], short: string, long: string): boolean {
  return words.includes(short) || words.includes(long)
}

function flagValue(words: readonly string[], short: string, long: string): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === short || w === long) return words[i + 1]
    if (w.startsWith(short + '=')) return w.slice(short.length + 1)
    if (w.startsWith(long + '=')) return w.slice(long.length + 1)
  }
  return undefined
}

const containerIdFrom = (stdout: string): string | undefined => /([a-f0-9]{12,64})/i.exec(stdout)?.[1]?.toLowerCase()

function detachedPid(stdout: string): number | undefined {
  const raw = /\b(\d{2,})\b/.exec(stdout)?.[1]
  const n = raw ? Number(raw) : NaN
  return Number.isSafeInteger(n) && n > 1 ? n : undefined
}

const shortCmd = (command: string): string => command.replace(/\s+/g, ' ').trim().slice(0, 80)

function pathBase(path: string): string | undefined {
  const clean = path.replace(/[\\/]+$/, '')
  if (!clean) return undefined
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts.at(-1)
}

function composeProject(words: readonly string[], command: string, cwd?: string): string {
  const fromFlag = flagValue(words, '-p', '--project-name')
  if (fromFlag) return fromFlag
  const fromEnv = /(?:^|\s)COMPOSE_PROJECT_NAME=([^\s]+)\s+(?:docker\s+compose|docker-compose)\b/.exec(command)?.[1]
  if (fromEnv) return fromEnv
  const projectDir = flagValue(words, '--project-directory', '--project-directory')
  const fromDir = projectDir ? pathBase(projectDir) : undefined
  if (fromDir) return fromDir
  const fromCwd = cwd ? pathBase(cwd) : undefined
  return fromCwd ?? 'compose'
}

function detachedCommand(command: string): string {
  let left = command.trim()
  while (left.startsWith('nohup ') || left.startsWith('setsid ')) {
    left = left.replace(/^(?:nohup|setsid)\s+/, '')
  }
  left = left.replace(/\s*&\s*(?:echo\s+\$!?|disown\b.*)?\s*$/, '')
  left = left.replace(/\s+\d?>\s*\S+/g, '')
  left = left.replace(/\s+\d?>>\s*\S+/g, '')
  left = left.replace(/\s+\d?>&\d+/g, '')
  return shortCmd(left)
}

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
  const words = toWords(command)
  const hasDocker = words[0] === 'docker'
  const hasCompose = (words[0] === 'docker' && words[1] === 'compose') || words[0] === 'docker-compose'

  const taskId = str(result?.backgroundTaskId)
  if (taskId) rows.push(backgroundRow(command, taskId, at, toolUseId))

  if (hasDocker && words[1] === 'run' && hasFlag(words, '-d', '--detach')) {
    const containerId = containerIdFrom(stdout)
    const name = flagValue(words, '--name', '--name') ?? containerId ?? shortCmd(command)
    rows.push({
      id: `docker:ctr:${containerId ?? name}`,
      kind: 'docker-container',
      name,
      state: 'running',
      firstSeen: at,
      lastSeen: at,
      ...(containerId !== undefined ? { containerId } : {}),
    })
  }

  if (hasCompose && words.includes('up') && hasFlag(words, '-d', '--detach')) {
    const project = composeProject(words, command, cwd)
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

  if (words[0] === 'tmux' && words.includes('new') && hasFlag(words, '-d', '-d')) {
    const session = flagValue(words, '-s', '-s') ?? 'tmux'
    rows.push({
      id: `tmux:${session}`,
      kind: 'tmux',
      name: session,
      state: 'running',
      firstSeen: at,
      lastSeen: at,
    })
  }

  if (words[0] === 'screen' && words.includes('-dmS')) {
    const idx = words.indexOf('-dmS')
    const session = words[idx + 1] ?? 'screen'
    rows.push({
      id: `screen:${session}`,
      kind: 'screen',
      name: session,
      state: 'running',
      firstSeen: at,
      lastSeen: at,
    })
  }

  const detached = /\bnohup\b|\bsetsid\b|&\s*(?:$|#)/.test(command)
  if (detached) {
    const pid = detachedPid(stdout)
    if (pid !== undefined) {
      const spawned = detachedCommand(command) || shortCmd(command)
      rows.push({
        id: `pid:${pid}`,
        kind: 'detached-process',
        name: spawned,
        state: 'running',
        firstSeen: at,
        lastSeen: at,
        pid,
        fingerprint: spawned,
      })
    }
  }
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

import { expect, test } from 'claude-code/testing'
import type { ProcessRecord, ProcessUiState } from '../hooks/contracts'
import { processBandPart, processSection } from '../hooks/ui/process-view'

const rec = (id: string, over: Partial<ProcessRecord>): ProcessRecord => ({
  id,
  kind: 'background-task',
  name: id,
  state: 'running',
  firstSeen: 1,
  lastSeen: 1,
  ...over,
})

const ui = (over: Partial<ProcessUiState> = {}): ProcessUiState => ({
  breaker: 'closed',
  ...over,
})

test('processBandPart prints count and failures', () => {
  const rows: ProcessRecord[] = [
    rec('a', { state: 'running' }),
    rec('b', { state: 'completed' }),
    rec('c', { state: 'failed' }),
  ]
  expect(processBandPart(rows)).toBe('Processes 3 (1 ✗)')
})

test('processSection renders rows and docker failure note', () => {
  const rows: ProcessRecord[] = [
    rec('bg', { kind: 'background-task', name: 'npm run dev' }),
    rec('ctr', { kind: 'docker-container', name: 'api', state: 'up' }),
    rec('tmux', { kind: 'tmux', name: 'dev', state: 'running' }),
  ]
  const section = processSection(rows, ui({ dockerIssue: 'docker daemon not reachable' }))
  expect(section).toBeTruthy()
  expect(section?.title).toBe('Processes')
  expect(section?.note).toContain('docker daemon not reachable')
  expect(section?.rows.map(r => [r.key, r.title, r.status])).toEqual([
    ['bg', 'npm run dev', 'running'],
    ['docker', 'api', 'up'],
    ['tmux', 'dev', 'running'],
  ])
})

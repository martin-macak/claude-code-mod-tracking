import { expect, test } from 'claude-code/testing'
import {
  dockerEntryMatchesRow,
  dockerStateFromStatus,
  parseDockerPs,
  parseScreenLs,
  parseTmuxLs,
  psStillMatches,
} from '../hooks/process/probe'

test('dockerStateFromStatus maps Up/Exited/health states', () => {
  expect(dockerStateFromStatus('Up 12 seconds')).toBe('up')
  expect(dockerStateFromStatus('Up 12 seconds (healthy)')).toBe('up')
  expect(dockerStateFromStatus('Up 12 seconds (unhealthy)')).toBe('unhealthy')
  expect(dockerStateFromStatus('Exited (1) 3 minutes ago')).toBe('exited')
})

test('parseDockerPs parses tab-separated rows', () => {
  const rows = parseDockerPs('a1b2c3\tapi\tUp 10 seconds\nb2c3d4\tdb\tExited (1) 2m ago\n')
  expect(rows).toEqual([
    { id: 'a1b2c3', name: 'api', state: 'up' },
    { id: 'b2c3d4', name: 'db', state: 'exited' },
  ])
})

test('parseTmuxLs and parseScreenLs extract named sessions', () => {
  expect(parseTmuxLs('dev: 1 windows (created Thu)\nwatch: 1 windows')).toEqual(['dev', 'watch'])
  expect(parseScreenLs('\t1234.watch\t(Detached)\n\t1235.dev\t(Detached)\n')).toEqual(['watch', 'dev'])
})

test('psStillMatches guards against pid reuse by command mismatch', () => {
  const out = 'Mon Oct 13 10:00:00 2026 npm run dev\n'
  expect(psStillMatches(out, 'npm run dev')).toBe(true)
  expect(psStillMatches(out, 'vite')).toBe(false)
})

test('dockerEntryMatchesRow matches short ids against full tracked ids', () => {
  const entry = { id: 'a1b2c3d4e5f6', name: 'api', state: 'up' as const }
  expect(dockerEntryMatchesRow(entry, { name: 'api', containerId: 'a1b2c3d4e5f6a7b8c9d0e1f2' })).toBe(true)
  expect(dockerEntryMatchesRow(entry, { name: 'api', containerId: 'fff2c3d4e5f6a7b8c9d0e1f2' })).toBe(false)
})

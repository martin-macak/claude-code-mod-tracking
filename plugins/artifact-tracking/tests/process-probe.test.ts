import { expect, test } from 'claude-code/testing'
import {
  composeState,
  dockerEntryMatchesRow,
  dockerStateFromStatus,
  findDetachedPid,
  parseDockerPs,
  parseScreenLs,
  parseTmuxLs,
  psStillMatches,
  screenLive,
  tmuxLive,
} from '../trackers/processes/probe'

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
  expect(dockerEntryMatchesRow(entry, { name: 'web', containerId: 'fff2c3d4e5f6a7b8c9d0e1f2' })).toBe(false)
})

// ---------------------------------------------------------------- probe variants (PR #34 review)

const r = (stdout: string, exitCode = 0, stderr = '') => ({ stdout, exitCode, stderr })
// Local time, as `ps -o lstart` prints it.
const at = (d: number, h: number, m: number, sec: number) => new Date(2026, 9, d, h, m, sec).getTime()

test('screenLive reads sessions although screen -ls exits 1 with live sessions (macOS and GNU screen)', () => {
  const live = r('There is a screen on:\n\t7611.probe-test\t(Detached)\n1 Socket in /tmp/.screen.\n', 1)
  expect(screenLive(live)).toEqual(['probe-test'])
  expect(screenLive(r('No Sockets found in /tmp/.screen.\n', 1))).toEqual([])
  // Linux prints a date column too.
  expect(screenLive(r('\t812.w\t(10/13/2026 10:00:00 AM)\t(Detached)\n', 1))).toEqual(['w'])
  expect(() => screenLive(r('', 127, 'screen: command not found'))).toThrow()
})

test('tmuxLive: no server or no socket dir means no sessions, other errors throw', () => {
  expect(tmuxLive(r('dev: 1 windows (created Tue)\n'))).toEqual(['dev'])
  expect(tmuxLive(r('', 1, 'no server running on /private/tmp/tmux-501/default\n'))).toEqual([])
  expect(tmuxLive(r('', 1, 'error connecting to /private/tmp/tmux-501/default (No such file or directory)\n'))).toEqual(
    [],
  )
  expect(() => tmuxLive(r('', 1, 'lost server'))).toThrow()
})

test('composeState: any unhealthy, else any up, else exited (order of rows does not matter)', () => {
  expect(composeState('Exited (0) 1 minute ago\nUp 5 seconds\n')).toBe('up')
  expect(composeState('Up 5 seconds\nUp 3 seconds (unhealthy)\n')).toBe('unhealthy')
  expect(composeState('Exited (1) 1 minute ago\n')).toBe('exited')
  expect(composeState('')).toBe('exited')
})

test('dockerEntryMatchesRow matches a named row by name when the stored id is wrong or missing', () => {
  const entry = { id: 'c0ffee000000', name: 'track-test-sleep' }
  expect(dockerEntryMatchesRow(entry, { name: 'track-test-sleep', containerId: 'fff62f14765df376' })).toBe(true)
  expect(dockerEntryMatchesRow(entry, { name: 'track-test-sleep' })).toBe(true)
  expect(dockerEntryMatchesRow(entry, { name: 'other' })).toBe(false)
})

test('psStillMatches: interpreter re-exec keeps the arguments (python3 -> Python.app)', () => {
  const out =
    'Tue Oct 13 20:26:39 2026     /Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m http.server 8000\n'
  expect(psStillMatches(out, 'python3 -m http.server 8000')).toBe(true)
  expect(psStillMatches(out, 'python3 -m http.server 9000')).toBe(false)
})

test('psStillMatches: a process that started after the row was seen is a reused pid', () => {
  const out = 'Tue Oct 13 20:26:39 2026 sleep 1800\n'
  expect(psStillMatches(out, 'sleep 1800', at(13, 20, 26, 40))).toBe(true)
  expect(psStillMatches(out, 'sleep 1800', at(13, 20, 20, 0))).toBe(false)
  expect(psStillMatches('Tue Oct 13 20:26:39 2026 sleep 18000\n', 'sleep 1800')).toBe(false)
  // Single-digit days are padded with a space.
  expect(psStillMatches('Sat Oct  3 09:00:00 2026 sleep 9\n', 'sleep 9', at(3, 9, 0, 1))).toBe(true)
})

test('findDetachedPid picks the newest matching process started before the row was seen', () => {
  const ps = [
    '  100 Tue Oct 13 20:00:00 2026 sleep 100',
    '  200 Tue Oct 13 20:26:39 2026 sleep 100',
    '  300 Tue Oct 13 20:30:00 2026 sleep 100',
    '  400 Tue Oct 13 20:26:39 2026 sleep 1000',
    '  500 Tue Oct 13 20:26:39 2026 /bin/zsh -c nohup sleep 100 &',
  ].join('\n')
  expect(findDetachedPid(ps, 'sleep 100', at(13, 20, 26, 40))).toBe(200)
  expect(findDetachedPid(ps, 'vite', at(13, 20, 26, 40))).toBeUndefined()
})

test('findDetachedPid does not take an old process with the same command (another project, hours ago)', () => {
  const ps = '  900 Tue Oct 13 18:00:00 2026 npm run dev\n'
  expect(findDetachedPid(ps, 'npm run dev', at(13, 20, 26, 40))).toBeUndefined()
  // Within the longest Bash call (10 minutes) it is still ours.
  expect(findDetachedPid('  901 Tue Oct 13 20:17:00 2026 npm run dev\n', 'npm run dev', at(13, 20, 26, 40))).toBe(901)
})

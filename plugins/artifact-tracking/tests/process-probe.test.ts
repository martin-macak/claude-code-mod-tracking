import { expect, test } from 'claude-code/testing'
import {
  composeState,
  dockerEntryMatchesRow,
  dockerStateFromStatus,
  findDetachedPid,
  hasUnexpandedVariable,
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

// ---------------------------------------------------------------- a fingerprint that names a variable (#56)

/** `${name}`, built so that no string of this file holds a template placeholder. */
const braced = (name: string) => ['$', '{', name, '}'].join('')

test('hasUnexpandedVariable: $NAME, braced names and $(...) count, a lone dollar or a price does not', () => {
  expect(hasUnexpandedVariable('node $F')).toBe(true)
  expect(hasUnexpandedVariable(`python3 ${braced('L')}/bin/reader.py`)).toBe(true)
  expect(hasUnexpandedVariable('srv --out $(mktemp)')).toBe(true)
  expect(hasUnexpandedVariable('node /work/srv.mjs')).toBe(false)
  expect(hasUnexpandedVariable('echo cost$')).toBe(false)
  expect(hasUnexpandedVariable('echo $5')).toBe(false)
})

test('psStillMatches: a word with a variable matches what the shell put in its place', () => {
  const at1 = at(13, 20, 26, 40)
  const line = (command: string) => `Tue Oct 13 20:26:39 2026 ${command}\n`
  expect(psStillMatches(line('node /work/srv.mjs'), 'node $F', at1)).toBe(true)
  expect(
    psStillMatches(line('python3 /p/lab/bin/reader.py /p/data/big.txt'), 'python3 $L/bin/reader.py $D/big.txt', at1),
  ).toBe(true)
  expect(
    psStillMatches(
      line('python3 /p/lab/bin/reader.py /p/data/big.txt'),
      `python3 ${braced('L')}/bin/reader.py $D/big.txt`,
      at1,
    ),
  ).toBe(true)
  // Words that are literal still have to match, and so does the program.
  expect(
    psStillMatches(line('python3 /p/lab/bin/other.py /p/data/big.txt'), 'python3 $L/bin/reader.py $D/big.txt', at1),
  ).toBe(false)
  expect(psStillMatches(line('ruby /work/srv.mjs'), 'node $F', at1)).toBe(false)
  expect(psStillMatches(line('/usr/bin/run --x'), '$B --x', at1)).toBe(true) // a variable program: any program
  expect(psStillMatches(line('/usr/bin/run --y'), '$B --x', at1)).toBe(false)
  // The command may have more words than the fingerprint kept, never fewer.
  expect(psStillMatches(line('node /work/srv.mjs --port 80'), 'node $F', at1)).toBe(true)
  expect(psStillMatches(line('node'), 'node $F', at1)).toBe(false)
  // The guard against pid reuse stays: a process that started after the row was seen is another process.
  expect(psStillMatches(line('node /work/srv.mjs'), 'node $F', at(13, 20, 20, 0))).toBe(false)
  // `daemon '$F' &` passes the text `$F`: the parser keeps it (process-parse.test.ts), and the live process still fits.
  expect(psStillMatches(line('daemon $F'), 'daemon $F', at1)).toBe(true)
})

test('findDetachedPid: a fingerprint with a variable takes the newest process of the window that fits', () => {
  const ps = [
    '  100 Tue Oct 13 20:26:39 2026 node /work/a.mjs',
    '  200 Tue Oct 13 20:26:39 2026 ruby /work/b.rb',
    '  300 Tue Oct 13 20:26:38 2026 node /work/c.mjs',
    '  400 Tue Oct 13 20:26:30 2026 node /elsewhere/a.mjs',
  ].join('\n')
  // `$D/a.mjs` keeps a literal part, so it is a constraint: 100 and 400 fit, 100 is the newest.
  expect(findDetachedPid(ps, 'node $D/a.mjs', at(13, 20, 26, 40))).toBe(100)
  expect(findDetachedPid(ps, 'node $D/c.mjs', at(13, 20, 26, 40))).toBe(300)
  expect(findDetachedPid(ps, 'python3 $D/a.mjs', at(13, 20, 26, 40))).toBeUndefined()
  // A literal fingerprint beats a loose one of the same process: the exact word wins over the variable.
  expect(findDetachedPid(ps, 'node /work/c.mjs', at(13, 20, 26, 40))).toBe(300)
})

test('findDetachedPid: a fingerprint of the program and variables only binds to no process', () => {
  // `node $F` says nothing but the program: the newest node process of the window would be taken for it, and a dead row
  // would show `running` with the pid of an unrelated process (#56 review, m1).
  const ps = '   22 Tue Oct 13 20:26:39 2026 node /other/project/dev-server.js\n'
  const first = at(13, 20, 26, 40)
  expect(findDetachedPid(ps, 'node $F', first)).toBeUndefined()
  expect(findDetachedPid(ps, `node ${braced('F')}`, first)).toBeUndefined()
  expect(findDetachedPid(ps, 'node $A $B', first)).toBeUndefined()
  expect(findDetachedPid(ps, 'node $(mktemp)', first)).toBeUndefined()
  expect(findDetachedPid(ps, '$BIN', first)).toBeUndefined()
  // A word with a literal part is a constraint, and the probe still looks.
  expect(findDetachedPid(ps, 'node $D/dev-server.js', first)).toBe(22)
  expect(findDetachedPid(ps, 'node --port=$P', first)).toBeUndefined() // `--port=` is literal, the process has no such word
  expect(findDetachedPid(ps, 'node $D/other.js', first)).toBeUndefined()
  // With the pid known the loose fingerprint is enough: the process is checked, not searched.
  expect(psStillMatches('Tue Oct 13 20:26:39 2026 node /other/project/dev-server.js\n', 'node $F', first)).toBe(true)
})

test('a variable stands for one word: a value of several words fits nothing', () => {
  const first = at(13, 20, 26, 40)
  const one = '   11 Tue Oct 13 20:26:39 2026 node a server.js\n'
  const several = '   11 Tue Oct 13 20:26:39 2026 node a b server.js\n'
  expect(findDetachedPid(one, 'node $ARGS server.js', first)).toBe(11)
  expect(findDetachedPid(several, 'node $ARGS server.js', first)).toBeUndefined()
})

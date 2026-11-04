// The pid of `echo $!` against a real bash (issue #353). The kit tests of the process parser feed it pid lines by hand, so
// they pin what the parser reads, not what bash prints. This test runs each form in bash, then asks `ps` which process each pid
// line names. For every row that the parser gives a pid, that process must be the row's command (`psStillMatches`, the check
// of the probe) and no shell. A row with no pid is always right: a safe miss. A pid whose process is gone proves nothing.
// The forms put a job into many places (a group, a subshell, a pipeline part, a list, a function, a substitution, a coproc)
// and read `$!` behind it through many wrappers. Each form runs in every bash it finds (macOS: /bin/bash 3.2 and Homebrew
// 5.x; Linux CI: one bash). It skips with no bash.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/pid-bash-differential.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseBashProcesses } from '../../plugins/artifact-tracking/trackers/processes/parse.ts'
import { psStillMatches } from '../../plugins/artifact-tracking/trackers/processes/probe.ts'

/** Every bash on this machine, once each. */
const shells = () => {
  const found = new Map()
  const add = path => {
    try {
      if (existsSync(path)) found.set(realpathSync(path), path)
    } catch {}
  }
  try {
    add(execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim())
  } catch {}
  for (const path of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) add(path)
  return [...found.values()]
}

// The durations name the jobs. No other process sleeps this long, so the cleanup can find them by their command too.
const BEFORE = 'sleep 7353100'
const JOB = 'sleep 7353101'
const OTHER = 'sleep 7353102'

// A job in a place. A `| cat` after a part that holds a job would wait for the job to close the pipe, so the forms use
// `| true` there. A job in `$( )` sends its output away for the same reason.
const PLACES = [
  `${JOB} &`,
  `! ${JOB} &`,
  `nohup ${JOB} >/dev/null 2>&1 &`,
  `${JOB} 2>/dev/null &`,
  `{ ${JOB} & };`,
  `( ${JOB} & );`,
  `( ${JOB} ) &`,
  `( true; ${JOB} ) &`,
  `( ${JOB}; true ) &`,
  `{ ${JOB}; } &`,
  `{ ${JOB} & } | true;`,
  `true | { ${JOB} & };`,
  `{ true | ${JOB} & } | true;`,
  `( ${JOB} & ) | true;`,
  `true | { ${JOB} & true | true; };`,
  `true && ${JOB} &`,
  `false || ${JOB} &`,
  `true && { ${JOB} & };`,
  `time ${JOB} &`,
  // A substitution in the middle cuts the command: the tail is no command of its own (issue #353).
  `env $(true) ${JOB} &`,
  `env \`true\` ${JOB} &`,
  `time env $(true) ${JOB} &`,
  `/usr/bin/time ${JOB} 2>/dev/null &`,
  `f() { ${JOB}; }; f &`,
  `function g { ${JOB}; true; }; g &`,
  `f() { ${JOB} & }; f;`,
  `sleep $(echo 7353101) &`,
  `${JOB} | true &`,
  `true | ${JOB} &`,
  `${OTHER} | ${JOB} &`,
  `true && ${OTHER} | ${JOB} &`,
  `coproc ${JOB};`,
  `coproc ${JOB} | true;`,
  `true | coproc ${JOB};`,
  `x=$(${JOB} >/dev/null &);`,
  `x=\`${JOB} >/dev/null &\`;`,
  `: <(${JOB});`,
  `eval "${JOB} &";`,
  'echo x &',
  'pwd &',
  '{ :; } &',
]

// Ways to read `$!` behind the job: in the same shell, in a group, a subshell, a pipeline part, a substitution and a compound.
const READS = [
  'echo $!',
  '{ echo $!; }',
  '( echo $! )',
  '( ( echo $! ) )',
  'true | { echo $!; }',
  'true | echo $!',
  'true | ( echo $! )',
  'echo $(echo $!)',
  'command echo $!',
  'if true; then echo $!; fi',
  'printf "%s\\n" $!',
  '{ true | echo $!; }',
  '( true ) | { echo $!; }',
  '( true | { echo $!; } )',
  '{ true | { echo $!; }; }',
]

/** Each form: a job before, the job in its place, then a read. Some forms read after each job, and after one more job. */
const FORMS = [
  ...PLACES.flatMap(place => READS.map(read => `${BEFORE} & ${place} ${read}`)),
  ...PLACES.flatMap(place =>
    ['echo $!', 'true | { echo $!; }', '( echo $! )'].map(
      read => `${BEFORE} & echo $!; ${place} ${read}; ${OTHER} & ${read}`,
    ),
  ),
]

const pause = ms => new Promise(done => setTimeout(done, ms))

/** The command line of a process, or '' when it is gone. */
const commandOf = pid => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const isShell = command => /^(\S*\/)?(ba)?sh$/.test(command.split(/\s+/)[0] ?? '')

/** Runs the form in its own process group, with its output in a file. A job keeps no pipe of the test open. */
async function run(bash, form, dir, n) {
  const file = join(dir, `out-${n}`)
  const fd = openSync(file, 'w')
  const child = spawn(bash, ['-c', form], { stdio: ['ignore', fd, 'ignore'], detached: true })
  closeSync(fd)
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  // A failed spawn fires `error` and no `exit`: wait for either, so the test does not hang.
  await new Promise(done => {
    child.on('exit', done)
    child.on('error', done)
  })
  clearTimeout(timer)
  const stdout = readFileSync(file, 'utf8')
  const wrong = []
  const rows = parseBashProcesses(form, { result: { stdout } }, { at: Date.now() }).filter(
    r => r.kind === 'detached-process' && r.pid !== undefined,
  )
  for (const row of rows) {
    // A forked job execs its command right after the fork. Wait for that, but not for a shell that runs a list: it stays one.
    let command = commandOf(row.pid)
    for (let k = 0; k < 20 && isShell(command); k++) {
      await pause(50)
      command = commandOf(row.pid)
    }
    if (command === '') continue
    if (isShell(command) || !psStillMatches(command, row.fingerprint))
      wrong.push(`${bash} | ${form} | row "${row.fingerprint}" took ${row.pid}, which is "${command}"`)
  }
  const pids = rows.map(r => r.pid)
  if (new Set(pids).size !== pids.length) wrong.push(`${bash} | ${form} | two rows share a pid: ${pids.join(', ')}`)
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
  return { wrong, paired: rows.map(r => r.fingerprint) }
}

const found = shells()

test('real bash: no row takes the pid of another process', { skip: found.length === 0, timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pid-differential-'))
  const wrong = []
  const pairedBy = new Map()
  try {
    const jobs = found.flatMap(bash => FORMS.map(form => ({ bash, form })))
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const n = next++
        const { bash, form } = jobs[n]
        const got = await run(bash, form, dir, n)
        wrong.push(...got.wrong)
        pairedBy.set(`${bash} | ${form}`, got.paired)
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
  } finally {
    try {
      execFileSync('pkill', ['-KILL', '-f', '^sleep 735310[0-2]$'])
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(wrong.sort(), [])
  // The check proves something only when rows do get pids: the plain forms must pair in every bash.
  for (const bash of found) {
    for (const [form, fingerprint] of [
      [`${BEFORE} & ${JOB} & echo $!`, JOB],
      [`${BEFORE} & { ${JOB} & } | true; echo $!`, BEFORE],
      [`${BEFORE} & true | { ${JOB} & }; ( echo $! )`, BEFORE],
      [`${BEFORE} & true | ${JOB} & echo $!`, JOB],
      [`${BEFORE} & ( ${JOB} & ); echo $!`, BEFORE],
    ]) {
      const key = `${bash} | ${form}`
      assert.ok(pairedBy.has(key), `the form runs: ${key}`)
      assert.ok(pairedBy.get(key).includes(fingerprint), `${key} gives "${fingerprint}" its pid`)
    }
  }
})

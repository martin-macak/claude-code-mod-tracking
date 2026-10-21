import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep as realSleep } from './wait.ts'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code

// What kept the lock from a claim:
// - `lock`: a live run holds the lock file.
// - `guard`: a live run holds the takeover guard of a stale lock, or the rounds ran out.
// - `self`: this process holds the lock, so waiting could not end.
// - `timeout`: the claim waited for the bound and gave up.
export type LockBusyKind = 'lock' | 'guard' | 'self' | 'timeout'

// The lock is busy. A `lock` or a `guard` is the failure of `acquireLock` that waiting can cure. `pid` is the run
// that holds it, when the file names one.
export class LockBusyError extends Error {
  readonly pid: number | undefined
  readonly kind: LockBusyKind
  constructor(message: string, pid?: number, kind: LockBusyKind = 'lock') {
    super(message)
    this.pid = pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined
    this.kind = kind
  }
}

// The pid in a lock file, or undefined when the file is gone.
function readPid(file: string): number | undefined {
  try {
    return Number(readFileSync(file, 'utf8'))
  } catch (err) {
    if (code(err) === 'ENOENT') return undefined
    throw err
  }
}

const live = (pid: number | undefined): pid is number =>
  pid !== undefined && Number.isInteger(pid) && pid > 0 && isAlive(pid)

const sleeper = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms: number) => void Atomics.wait(sleeper, 0, 0, ms)

// A rename or an rmdir that meets a folder with a file in it: an expected answer, not a failure.
const NOT_EMPTY = ['ENOTEMPTY', 'EEXIST']
const dropFolder = (folder: string) => {
  try {
    rmdirSync(folder)
  } catch (err) {
    if (![...NOT_EMPTY, 'ENOENT'].includes(code(err) ?? '')) throw err
  }
}

// The takeover guard. Only the run that holds it may check a stale lock and remove it. Without
// it, a run that read a stale lock could remove the live lock of a run that took over in the
// meantime, and a third run could then take the lock too.
//
// The guard is a folder with one file in it, named by the pid of its holder. The folder is built
// in private first, and a rename publishes it. The rename is atomic. It fails while a guard
// with a file in it exists, so a published guard always holds a pid. A run that crashed leaves
// its guard behind, and the next run clears it with no new race:
// - It removes only the file of a dead pid, by name. A guard that a run published after
//   that read has another file name, so it stays.
// - It then removes the folder with `rmdirSync`. That fails while the folder holds a file.
//   An empty folder is a free guard: the rename of the next run replaces it.
// So any number of runs can clear a stale guard at once, and none can remove a live one.
// A crash can also leave the private folder `.lock.takeover.tmp-<pid>` (and `.lock.tmp-<pid>`,
// the private file of the lock). Both are inert: nothing reads them, and a run with that pid
// replaces them.
function publishGuard(guard: string): boolean {
  const prepared = `${guard}.tmp-${process.pid}`
  rmSync(prepared, { recursive: true, force: true })
  mkdirSync(prepared)
  writeFileSync(join(prepared, String(process.pid)), '')
  try {
    renameSync(prepared, guard)
    return true
  } catch (err) {
    rmSync(prepared, { recursive: true, force: true })
    if (NOT_EMPTY.includes(code(err) ?? '')) return false
    throw err
  }
}

// The holders of the guard (the names of its files), or undefined when there is no guard.
function guardHolders(guard: string): string[] | undefined {
  try {
    return readdirSync(guard)
  } catch (err) {
    if (code(err) === 'ENOENT') return undefined
    throw err
  }
}

function clearStaleGuard(guard: string, holders: string[]) {
  for (const holder of holders) rmSync(join(guard, holder), { force: true })
  dropFolder(guard)
}

function releaseGuard(guard: string) {
  rmSync(join(guard, String(process.pid)), { force: true })
  dropFolder(guard)
}

// A round is one try at the lock. A round that waits for the guard of a live run pauses 5 ms, and a try
// pauses 1000 times at most: at least 5 s of waiting. A run that is stuck in the guard for that long is
// treated as lost. The pause is synchronous, so a caller with less time to spare passes a shorter bound.
const MAX_ROUNDS = 1000
const WAIT_MS = 5
const GUARD_WAIT_MS = MAX_ROUNDS * WAIT_MS

export type AcquireOptions = {
  /** The longest this try waits for the takeover guard of a live run, in ms. 0: do not wait. */
  guardWaitMs?: number
  /** Waits for the guard. The default blocks this thread. A test passes a fake, so no real time passes. */
  pause?: (ms: number) => void
}

// One run at a time. The pid goes to a private file first. A hard link then publishes that file as
// `.lock`. The link is atomic and fails with EEXIST while a lock exists, so `.lock` never exists
// without a pid: a second run cannot read an empty file as pid 0 and take a live lock.
// A lock left by a dead process is taken over. Only the run that holds the takeover guard (see
// publishGuard) may remove it. It reads the pid again with the guard held. A lock that is live
// now stays: the run that took it over came first. A lock of a dead pid cannot change while the
// guard is held, because no one else removes it and the dead holder cannot release it. So the
// removal never hits a live lock, and a run that holds a lock never loses it.
// A run that finds the guard held by a live run waits for it and then reads the lock again.
export function acquireLock(
  dir: string,
  { guardWaitMs = GUARD_WAIT_MS, pause = sleepSync }: AcquireOptions = {},
): () => void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.lock')
  const guard = `${file}.takeover`
  const mine = `${file}.tmp-${process.pid}`
  writeFileSync(mine, String(process.pid))
  try {
    let waitedFor: string[] | undefined // The live holders of the guard that this round waited for.
    let pauses = 0
    const maxPauses = Math.floor(guardWaitMs / WAIT_MS)
    for (let round = 0; round < MAX_ROUNDS; round++) {
      try {
        linkSync(mine, file)
        return () => rmSync(file, { force: true })
      } catch (err) {
        if (code(err) !== 'EEXIST') throw err
      }
      waitedFor = undefined
      const pid = readPid(file)
      if (live(pid)) throw new LockBusyError(`lock: another demo run (pid ${pid}) holds ${file}`, pid)
      if (pid === undefined) continue // another run removed it first
      if (!publishGuard(guard)) {
        const holders = guardHolders(guard)
        if (holders === undefined) continue // the guard went away: try again
        // This run holds no guard now, so its own pid in the guard is a leftover of a crashed run
        // that had the same pid.
        if (holders.every(holder => Number(holder) === process.pid || !live(Number(holder)))) {
          clearStaleGuard(guard, holders)
          continue
        }
        waitedFor = holders
        if (pauses++ >= maxPauses) break // This try has waited for the guard as long as it may.
        pause(WAIT_MS)
        continue
      }
      try {
        const current = readPid(file)
        if (live(current)) throw new LockBusyError(`lock: another demo run (pid ${current}) holds ${file}`, current)
        if (current !== undefined) rmSync(file, { force: true })
      } finally {
        releaseGuard(guard)
      }
    }
    // The old text stays first. A guard that stays live names its holder, as the lock does.
    throw new LockBusyError(
      `lock: could not take ${file}` +
        (waitedFor === undefined ? '' : ` (takeover guard ${guard} held by pid ${waitedFor.join(', ')})`),
      Number(waitedFor?.[0]),
      'guard',
    )
  } finally {
    rmSync(mine, { force: true })
  }
}

// How often a claim that waits tries the lock again.
export const LOCK_POLL_MS = 5000
// A claim that waits says again, this often, that it still waits.
const REMIND_MS = 60_000

export type ClaimOptions = {
  /** How long to wait for a lock that a live run holds. 0: fail at once. */
  waitMs: number
  pollMs?: number
  /** The clock and the sleep of the wait. A test passes fakes, so no real time passes. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Says who a pid is. The default asks `ps`. */
  describeHolder?: (pid: number) => string
  /** Whether the run that held the lock still lives. A claim waits for its process, not only for the file. */
  isLive?: (pid: number) => boolean
  /** Waits for the takeover guard of a live run, as `acquireLock` does by default. A test passes a fake. */
  guardPause?: (ms: number) => void
  /** Gets each note about the wait. The default writes to stderr: the formatter owns stdout. */
  onWait?: (note: string) => void
}

// The pid and, for a live process, the time it runs and its command line, as `ps` tells them. The command
// line shows which worktree runs it. Without `ps`, or for a dead pid, only the pid.
export function describeHolder(pid: number): string {
  try {
    const out = execFileSync('ps', ['-o', 'etime=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    const [, up, command] = /^(\S+)\s+(.*)$/s.exec(out) ?? []
    if (up === undefined || command === undefined) return `pid ${pid}`
    return `pid ${pid}, up ${up}: ${command.length > 160 ? `${command.slice(0, 160)}...` : command}`
  } catch {
    return `pid ${pid}`
  }
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} s`
  const rest = total % 60
  return `${Math.floor(total / 60)} min${rest === 0 ? '' : ` ${rest} s`}`
}

// Waits for the lock: one `acquireLock` attempt every `pollMs`, for at most `waitMs`. A run that waits says
// who holds the lock, once for each holder, and again every minute. It never removes the lock of a live
// run. `acquireLock` takes over a stale lock, and only that.
//
// A claim waits for the process of the holder, not only for the file. A run lets go of the lock after each
// scenario and takes it again a moment later. An older checkout does not wait, so a claim that took the lock
// in that moment would fail the next scenario of that run at once (issue #143). So once a busy answer has named
// the holder of the lock file, the claim tries again only when no such run lives or the file is there again.
// The claim of a run that lives on without the lock, and does not take it again, gives up after the bound.
async function waitForLock(dir: string, opts: ClaimOptions): Promise<() => void> {
  const {
    waitMs,
    pollMs = LOCK_POLL_MS,
    now = Date.now,
    sleep = realSleep,
    describeHolder: who = describeHolder,
    isLive = isAlive,
    guardPause,
  } = opts
  const say = opts.onWait ?? ((note: string) => void process.stderr.write(`${note}\n`))
  const file = join(dir, '.lock')
  const start = now()
  let holder: number | undefined // The run that held the lock file when the last try failed.
  let waitingFor: number | undefined // The run that the notes and the timeout name.
  let named: number | undefined // The run that the last note named.
  let said = false
  let notedAt = 0
  for (;;) {
    const between = holder !== undefined && isLive(holder) && readPid(file) === undefined
    if (!between) {
      try {
        // A try that finds the guard of a live run pauses for it, and does not return before. So it pauses for as long as
        // the claim has time left, and not at all with no wait (issue #168 review).
        const left = Math.max(0, waitMs - (now() - start))
        return acquireLock(dir, {
          guardWaitMs: Math.min(GUARD_WAIT_MS, left),
          ...(guardPause === undefined ? {} : { pause: guardPause }),
        })
      } catch (err) {
        if (!(err instanceof LockBusyError)) throw err
        // A run that waits for its own pid would wait for ever: a scenario of this process kept the lock.
        if (err.kind === 'lock' && err.pid === process.pid) {
          throw new LockBusyError(
            `lock: this process (pid ${process.pid}) already holds ${file}: a scenario did not release it`,
            err.pid,
            'self',
          )
        }
        if (waitMs <= 0) throw err
        waitingFor = err.pid
        holder = err.kind === 'lock' ? err.pid : undefined
      }
    }
    const waited = now() - start
    const describe = () => (waitingFor === undefined ? 'a live run' : who(waitingFor)) // `ps` runs only when a note needs it.
    if (waited >= waitMs) {
      throw new LockBusyError(
        `lock: another demo run (pid ${waitingFor}) holds ${file}. Waited ${seconds(waited)} for it and gave up. ` +
          `It still runs (${describe()}). Wait for it to end, or set DEMO_LOCK_WAIT_S above ${Math.round(waitMs / 1000)}.`,
        waitingFor,
        'timeout',
      )
    }
    if (!said || waitingFor !== named) {
      say(
        `lock: another demo run holds ${file}: ${describe()}. Waiting for it ` +
          `(poll every ${seconds(pollMs)}, give up after ${seconds(waitMs)}).`,
      )
      said = true
      named = waitingFor
      notedAt = waited
    } else if (waited - notedAt >= REMIND_MS) {
      say(`lock: still waiting after ${seconds(waited)} for ${describe()}.`)
      notedAt = waited
    }
    await sleep(Math.min(pollMs, waitMs - waited))
  }
}

// Takes the lock first, then wipes and makes the scenario folder, so a second run never
// touches the files of a run that is still going. A lock that a live run holds is waited for (see
// waitForLock), not failed on at once.
export async function claimRun(lockDir: string, runDir: string, opts: ClaimOptions): Promise<() => void> {
  const release = await waitForLock(lockDir, opts)
  try {
    rmSync(runDir, { recursive: true, force: true })
    mkdirSync(runDir, { recursive: true })
  } catch (err) {
    release()
    throw err
  }
  return release
}

// A `claimRun` for all the scenarios of one run. A run of 20 scenarios that waits the whole bound for
// each of them would wait for 20 bounds. So after the first timeout the later scenarios try once and
// fail at once, unless the lock is free by then.
export function makeClaimer(opts: ClaimOptions): (lockDir: string, runDir: string) => Promise<() => void> {
  let gaveUp: string | undefined
  return async (lockDir, runDir) => {
    if (gaveUp === undefined) {
      try {
        return await claimRun(lockDir, runDir, opts)
      } catch (err) {
        // Only a claim that waited the whole bound says so. A failure at once waited for nothing.
        if (err instanceof LockBusyError && err.kind === 'timeout') gaveUp = seconds(opts.waitMs)
        throw err
      }
    }
    try {
      return await claimRun(lockDir, runDir, { ...opts, waitMs: 0 })
    } catch (err) {
      if (!(err instanceof LockBusyError) || err.kind === 'self') throw err
      throw new LockBusyError(
        `${err.message} (an earlier scenario of this run already waited ${gaveUp})`,
        err.pid,
        err.kind,
      )
    }
  }
}

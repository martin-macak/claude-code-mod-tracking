import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code

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
const pause = (ms: number) => void Atomics.wait(sleeper, 0, 0, ms)

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

// A round is one try at the lock. A round that waits for the guard of a live run sleeps 5 ms, so
// 1000 rounds are at least 5 s of waiting. A run that is stuck in the guard for that long is
// treated as lost.
const MAX_ROUNDS = 1000
const WAIT_MS = 5

// One run at a time. The pid goes to a private file first. A hard link then publishes that file as
// `.lock`. The link is atomic and fails with EEXIST while a lock exists, so `.lock` never exists
// without a pid: a second run cannot read an empty file as pid 0 and take a live lock.
// A lock left by a dead process is taken over. Only the run that holds the takeover guard (see
// publishGuard) may remove it. It reads the pid again with the guard held. A lock that is live
// now stays: the run that took it over came first. A lock of a dead pid cannot change while the
// guard is held, because no one else removes it and the dead holder cannot release it. So the
// removal never hits a live lock, and a run that holds a lock never loses it.
// A run that finds the guard held by a live run waits for it and then reads the lock again.
export function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.lock')
  const guard = `${file}.takeover`
  const mine = `${file}.tmp-${process.pid}`
  writeFileSync(mine, String(process.pid))
  try {
    let waitedFor: string[] | undefined // The live holders of the guard that this round waited for.
    for (let round = 0; round < MAX_ROUNDS; round++) {
      try {
        linkSync(mine, file)
        return () => rmSync(file, { force: true })
      } catch (err) {
        if (code(err) !== 'EEXIST') throw err
      }
      waitedFor = undefined
      const pid = readPid(file)
      if (live(pid)) throw new Error(`lock: another demo run (pid ${pid}) holds ${file}`)
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
        pause(WAIT_MS)
        waitedFor = holders
        continue
      }
      try {
        const current = readPid(file)
        if (live(current)) throw new Error(`lock: another demo run (pid ${current}) holds ${file}`)
        if (current !== undefined) rmSync(file, { force: true })
      } finally {
        releaseGuard(guard)
      }
    }
    // The old text stays first. A guard that stays live names its holder, as the lock does.
    throw new Error(
      `lock: could not take ${file}` +
        (waitedFor === undefined ? '' : ` (takeover guard ${guard} held by pid ${waitedFor.join(', ')})`),
    )
  } finally {
    rmSync(mine, { force: true })
  }
}

// Takes the lock first, then wipes and makes the scenario folder, so a second run never
// touches the files of a run that is still going.
export function claimRun(lockDir: string, runDir: string): () => void {
  const release = acquireLock(lockDir)
  try {
    rmSync(runDir, { recursive: true, force: true })
    mkdirSync(runDir, { recursive: true })
  } catch (err) {
    release()
    throw err
  }
  return release
}

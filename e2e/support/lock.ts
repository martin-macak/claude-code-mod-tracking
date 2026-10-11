import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

// One run at a time. A lock left by a dead process is taken over: the stale file is renamed aside,
// and only one run can win that rename. The loser tries again and then sees the winner's live pid.
export function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.lock')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      return () => rmSync(file, { force: true })
    } catch (err) {
      if (code(err) !== 'EEXIST') throw err
    }
    const pid = readPid(file)
    if (live(pid)) throw new Error(`lock: another demo run (pid ${pid}) holds ${file}`)
    const aside = `${file}.stale-${process.pid}`
    try {
      renameSync(file, aside)
    } catch (err) {
      if (code(err) === 'ENOENT') continue // another run moved it first
      throw err
    }
    const moved = readPid(aside)
    if (live(moved)) {
      // A run took the lock between our read and our rename. Give it back.
      renameSync(aside, file)
      throw new Error(`lock: another demo run (pid ${moved}) holds ${file}`)
    }
    rmSync(aside, { force: true })
  }
  throw new Error(`lock: could not take ${file}`)
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

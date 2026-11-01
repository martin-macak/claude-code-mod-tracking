import { type Config, LOCK_DIR, lockDirsOf, OUT_DIR, outDirOf } from './config.ts'
import type { Claimer } from './lock.ts'

/**
 * The longest `claimScenario` may wait for its locks, in ms: one wait of `waitMs` for each lock it takes in turn (a run on its
 * own socket that is not private takes two). The Before hook of world.ts takes this as its budget, so the hook cannot time out
 * while a claim still waits and then lets that claim go on with setup after teardown.
 */
export function claimBudgetMs(config: Config, waitMs: number): number {
  return lockDirsOf(config).length * waitMs
}

/**
 * Takes the lock of one scenario and empties its run folder (issue #185): the shared lock for a default run, the lock of the
 * socket for a private one, both for a run on its own socket that is not private. world.ts calls this, so a test of it
 * covers the choice of locks and folder.
 */
export async function claimScenario(
  claim: Claimer,
  config: Config,
  scenario: string,
  // Folders of the shared lock and of the output: a test gives its own, so it touches neither the real lock nor `e2e/out`.
  { lock = LOCK_DIR, out = OUT_DIR }: { lock?: string; out?: string } = {},
): Promise<{ outDir: string; release: () => void }> {
  const outDir = outDirOf(config, scenario, out)
  const releases: Array<() => void> = []
  try {
    // The run folder is emptied by each claim: nothing is written to it between them.
    for (const dir of lockDirsOf(config, lock)) releases.push(await claim(dir, outDir))
  } catch (err) {
    for (const release of releases.reverse()) release()
    throw err
  }
  return {
    outDir,
    release: () => {
      for (const release of releases.reverse()) release()
    },
  }
}

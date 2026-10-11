import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  After,
  Before,
  type ITestCaseHookParameter,
  Status,
  setDefaultTimeout,
  setWorldConstructor,
  World,
} from '@cucumber/cucumber'
import { CLONE_NAME, type Config, LOCK_DIR, loadConfig, OUT_DIR, PLUGIN_DIR, REPO_ROOT } from './config.ts'
import { claimRun } from './lock.ts'
import { Recorder } from './recorder.ts'
import { countLines, launchClaude, prepareClone, waitForTurnEnd } from './session.ts'
import { slug } from './slug.ts'
import { Timeline } from './timeline.ts'
import { Tmux } from './tmux.ts'
import { waitUntil } from './wait.ts'

// Each wait inside a step has its own, shorter timeout from Config.
setDefaultTimeout(10 * 60 * 1000)

let recordedScenarios = 0

export class DemoWorld extends World {
  config: Config = loadConfig()
  // Fixed name: the lock in LOCK_DIR allows one run at a time, and setUp kills a server left by a crashed run.
  tmux = new Tmux('cc-demo')
  recorder = new Recorder()
  timeline: Timeline | undefined
  outDir = ''
  signalFile = ''
  turnMark = 0
  private release: (() => void) | undefined

  get tl(): Timeline {
    if (this.timeline === undefined) throw new Error('world: setUp did not run')
    return this.timeline
  }

  async setUp(name: string): Promise<void> {
    const { record, cols, rows, dir } = this.config
    if (record && ++recordedScenarios > 1) throw new Error('demo: only one @demo scenario can be recorded per run')
    this.outDir = join(OUT_DIR, record ? 'demo' : slug(name))
    this.release = claimRun(LOCK_DIR, this.outDir)
    this.signalFile = join(this.outDir, 'signal')
    this.timeline = new Timeline(join(this.outDir, 'timeline.ndjson'))
    this.tmux.kill()
    const clone = prepareClone(REPO_ROOT, dir)
    this.tmux.start({ cols, rows, cwd: clone, confDir: this.outDir })
    if (record) await this.recorder.start(this.tmux, { castFile: join(this.outDir, 'session.cast'), cols, rows })
    const nonce = `SYNC-${randomUUID().slice(0, 8)}`
    this.tmux.caption(nonce)
    this.tl.sync(nonce)
    this.tl.phase('cut')
  }

  async launch(prompt?: string): Promise<void> {
    this.tl.phase('cut')
    await launchClaude(
      {
        tmux: this.tmux,
        signalFile: this.signalFile,
        pluginDir: PLUGIN_DIR,
        model: this.config.model,
        timeoutMs: this.config.turnTimeoutMs,
      },
      prompt,
    )
    this.tl.phase('normal')
  }

  async typePrompt(text: string): Promise<void> {
    this.tl.phase('normal')
    this.turnMark = countLines(this.signalFile)
    await this.tmux.type(text, this.config.typeDelayMs)
    this.tmux.key('Enter')
  }

  async finishTurn(): Promise<void> {
    this.tl.phase('fast')
    await waitForTurnEnd(this.signalFile, this.turnMark, this.config.turnTimeoutMs, () => this.tmux.capture())
    this.tl.phase('normal')
  }

  async waitScreen(test: (screen: string) => boolean, what: string): Promise<void> {
    this.tl.phase('fast')
    await waitUntil(() => (test(this.tmux.capture()) ? true : undefined), {
      timeoutMs: this.config.screenTimeoutMs,
      what,
      last: () => this.tmux.capture(),
    })
    this.tl.phase('normal')
  }

  async tearDown(failed: boolean): Promise<void> {
    if (this.release === undefined) return // setUp failed before the lock: touch nothing
    try {
      if (failed) {
        try {
          writeFileSync(join(this.outDir, 'screen.txt'), this.tmux.capture())
        } catch {
          // No pane to capture.
        }
      }
      this.timeline?.end()
      await this.recorder.stop(this.tmux)
    } finally {
      if (!this.config.keep) {
        this.tmux.kill()
        rmSync(join(this.config.dir, CLONE_NAME), { recursive: true, force: true })
      }
      this.release()
      this.release = undefined
    }
  }
}

setWorldConstructor(DemoWorld)

Before(async function (this: DemoWorld, { pickle }: ITestCaseHookParameter) {
  await this.setUp(pickle.name)
})

After(async function (this: DemoWorld, { result }: ITestCaseHookParameter) {
  await this.tearDown(result?.status === Status.FAILED)
})

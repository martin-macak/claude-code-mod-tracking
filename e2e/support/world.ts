import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import type { FakeGhSpec } from './fake-gh.ts'
import { fakeGhEnv } from './fake-gh-env.ts'
import { makeClaimer } from './lock.ts'
import { withFocus } from './pane.ts'
import { Recorder } from './recorder.ts'
import { countLines, FAKE_ORIGIN_NAME, launchClaude, prepareClone, waitForTurnEnd } from './session.ts'
import { slug } from './slug.ts'
import { Timeline } from './timeline.ts'
import { Tmux } from './tmux.ts'
import { waitUntil } from './wait.ts'

// Each wait inside a step has its own, shorter timeout from Config.
const STEP_TIMEOUT_MS = 10 * 60 * 1000
setDefaultTimeout(STEP_TIMEOUT_MS)

// Every scenario takes the lock of the machine in its Before hook, and waits for it while another run holds it
// (support/lock.ts). After the first timeout the later scenarios do not wait again.
const { lockWaitMs } = loadConfig()
const claimRun = makeClaimer({ waitMs: lockWaitMs })

let recordedScenarios = 0

export class DemoWorld extends World {
  config: Config = loadConfig()
  // Fixed name: the lock in LOCK_DIR allows one run at a time, and setUp kills a server left by a crashed run.
  tmux = new Tmux('cc-demo')
  recorder = new Recorder()
  timeline: Timeline | undefined
  outDir = ''
  signalFile = ''
  /** CLAUDE_TRACKER_CONFIG_DIR of this scenario: an empty folder, so no run touches the real config file. */
  configDir = ''
  turnMark = 0
  /** The artifact a scenario published and did not delete yet. A failed run deletes it (artifact.steps.ts). */
  artifact: string | undefined
  /** The fake gh of this scenario (support/fake-gh.ts). Absent: claude runs the real gh. */
  fakeGh: FakeGhSpec | undefined
  /** The refs of the local copy that stands for the origin, as the scenario started (steps/fake-gh.steps.ts). */
  fakeOriginRefs: string | undefined
  private release: (() => void) | undefined

  get cloneDir(): string {
    return join(this.config.dir, CLONE_NAME)
  }

  /** The files the fake gh reads and writes: the spec it answers from, and the log of its calls. */
  get fakeGhFiles(): { specFile: string; logFile: string } {
    return { specFile: join(this.outDir, 'fake-gh.json'), logFile: join(this.outDir, 'fake-gh.log') }
  }

  /**
   * Sets what the fake gh answers. Claude gets the fake from the next launch. The log starts empty: the steps that read
   * it must never pass on the calls of an earlier run, whatever the lock does with the folder of the scenario.
   */
  setFakeGh(spec: FakeGhSpec): void {
    this.fakeGh = spec
    writeFileSync(this.fakeGhFiles.specFile, JSON.stringify(spec))
    writeFileSync(this.fakeGhFiles.logFile, '')
  }

  get tl(): Timeline {
    if (this.timeline === undefined) throw new Error('world: setUp did not run')
    return this.timeline
  }

  async setUp(name: string): Promise<void> {
    const { record, cols, rows, dir } = this.config
    if (record && ++recordedScenarios > 1) throw new Error('demo: only one @demo scenario can be recorded per run')
    this.outDir = join(OUT_DIR, record ? 'demo' : slug(name))
    this.release = await claimRun(LOCK_DIR, this.outDir)
    this.configDir = mkdtempSync(join(tmpdir(), 'cc-tracker-config-'))
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

  async launch(prompt?: string, tools?: readonly string[]): Promise<void> {
    this.tl.phase('cut')
    await launchClaude(
      {
        tmux: this.tmux,
        signalFile: this.signalFile,
        pluginDir: PLUGIN_DIR,
        model: this.config.model,
        timeoutMs: this.config.turnTimeoutMs,
        ...(tools ? { tools } : {}),
        env: { CLAUDE_TRACKER_CONFIG_DIR: this.configDir, ...(this.fakeGh ? fakeGhEnv(this.fakeGhFiles) : {}) },
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

  // `ansi`: the test reads the screen with its escape sequences (`Tmux.captureAnsi`).
  async waitScreen(test: (screen: string) => boolean, what: string, opts: { ansi?: boolean } = {}): Promise<void> {
    this.tl.phase('fast')
    const read = () => (opts.ansi ? this.tmux.captureAnsi() : this.tmux.capture())
    await waitUntil(() => (test(read()) ? true : undefined), {
      timeoutMs: this.config.screenTimeoutMs,
      what,
      last: () => (opts.ansi ? withFocus(this.tmux.capture(), this.tmux.captureAnsi()) : this.tmux.capture()),
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
        rmSync(this.cloneDir, { recursive: true, force: true })
        rmSync(join(this.config.dir, FAKE_ORIGIN_NAME), { recursive: true, force: true })
        rmSync(this.configDir, { recursive: true, force: true })
      }
      this.release()
      this.release = undefined
    }
  }
}

setWorldConstructor(DemoWorld)

// The hook may wait for the lock as long as Config allows, and then needs the time that the default gives it.
Before({ timeout: lockWaitMs + STEP_TIMEOUT_MS }, async function (this: DemoWorld, { pickle }: ITestCaseHookParameter) {
  await this.setUp(pickle.name)
})

After(async function (this: DemoWorld, { result }: ITestCaseHookParameter) {
  await this.tearDown(result?.status === Status.FAILED)
})

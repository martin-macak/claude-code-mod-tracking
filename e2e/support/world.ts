import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  After,
  AfterAll,
  Before,
  type ITestCaseHookParameter,
  Status,
  setDefaultTimeout,
  setWorldConstructor,
  World,
} from '@cucumber/cucumber'
import { CLONE_NAME, type Config, loadConfig, lockDirOf, outDirOf, PLUGIN_DIR, REPO_ROOT } from './config.ts'
import { CONFIG_FILE, makeConfigDir, pathWidthRefusal } from './config-dir.ts'
import { type CopyProbe, writeCopyProbe } from './copy-probe.ts'
import { FakeApi, type FakeTurn } from './fake-api.ts'
import { FAKE_HOME_TEXT, fakeApiEnv, homeFile, PARENT_SESSION_VARS } from './fake-api-env.ts'
import type { FakeGhSpec } from './fake-gh.ts'
import { fakeGhEnv } from './fake-gh-env.ts'
import { makeClaimer } from './lock.ts'
import { withFocus } from './pane.ts'
import { Recorder } from './recorder.ts'
import { countLines, FAKE_ORIGIN_NAME, fakeForeignRepo, launchClaude, prepareClone, waitForTurnEnd } from './session.ts'
import { sizeRefusal } from './size.ts'
import { slug } from './slug.ts'
import { Timeline } from './timeline.ts'
import { type TimerRefuser, timerRefuserRefusal, writeTimerRefuser } from './timer-refuser.ts'
import { Tmux } from './tmux.ts'
import { waitUntil } from './wait.ts'

// Each wait inside a step has its own, shorter timeout from Config.
const STEP_TIMEOUT_MS = 10 * 60 * 1000
setDefaultTimeout(STEP_TIMEOUT_MS)

// Every scenario takes the lock of the machine in its Before hook, and waits for it while another run holds it
// (support/lock.ts). After the first timeout the later scenarios do not wait again. The runs get the lock in the order they
// came: this run joins the queue of runs at its first claim and leaves it in the AfterAll hook below. A run with its own
// tmux socket and folder (DEMO_SOCKET and DEMO_DIR, issue #185) takes a lock of its own socket instead: `lockDirOf`.
const { lockWaitMs } = loadConfig()
const claimRun = makeClaimer({ waitMs: lockWaitMs })

let recordedScenarios = 0

export class DemoWorld extends World {
  config: Config = loadConfig()
  // One run at a time uses a socket (the lock of `lockDirOf`), and setUp kills a server left by a crashed run.
  tmux = new Tmux(this.config.socket)
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
  /** The age in seconds of the last refresh as the screen showed it when the scenario noted it (steps/screen.steps.ts). */
  notedRefreshAge: number | undefined
  /** The fake Messages API of this scenario (support/fake-api.ts). Absent: claude talks to the real model. */
  fakeApi: FakeApi | undefined
  /** The config folder of the session that runs against the fake API: empty, so no login or setting of the person reaches it. */
  fakeHome = ''
  /** The probe plugin that answers `ui.copy` (support/copy-probe.ts). Absent: the copy key writes the real clipboard. */
  copyProbe: CopyProbe | undefined
  /** The probe plugin that denies one `clock.after` delay (support/timer-refuser.ts). Absent: no timer is refused. */
  timerRefuser: TimerRefuser | undefined
  /** The file the session writes its debug log to (`--debug-file`, support/debug-log.ts). Absent: the session writes none. */
  debugLog: string | undefined
  /** The second repo of the scenario (issue #195, `fakeForeignRepo`). Absent: the scenario has none. */
  foreignRepo: { dir: string; readme: string; bare: string } | undefined
  private foreignDir = ''
  /** Every probe plugin of the scenario: its folder (removed at the end) and its plugin folder (loaded by the launch). */
  private probes: { dir: string; pluginDir: string }[] = []
  private release: (() => void) | undefined
  private launched = false

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

  /**
   * Makes the next launch talk to a fake model that plays `turns`, in a config folder of its own. Before the session starts:
   * the model of a running session cannot change. The scenario closes it at the end (`tearDown`).
   */
  async startFakeApi(turns: readonly FakeTurn[]): Promise<void> {
    if (this.launched) throw new Error('fake api: start it before the step that starts the session')
    await this.fakeApi?.close()
    this.fakeApi = await FakeApi.start(turns)
    if (this.fakeHome === '') {
      this.fakeHome = mkdtempSync(join(tmpdir(), 'cc-fake-home-'))
      writeFileSync(homeFile(this.fakeHome), FAKE_HOME_TEXT)
    }
  }

  /**
   * Makes a second repo that the session reads from but does not start in, on a feature branch, with a GitHub `origin`
   * (`fakeForeignRepo`). It lives in `$HOME/.cache/cc-demo/<run>`: a temporary folder would be noise for the repos tracker,
   * which makes no row of a repo there. The scenario removes the folder at the end (`tearDown`).
   */
  makeForeignRepo(ownerRepo: string, branch: string): void {
    if (this.launched) throw new Error('second repo: make it before the step that starts the session')
    if (this.foreignDir === '') {
      const cache = join(homedir(), '.cache', 'cc-demo')
      mkdirSync(cache, { recursive: true })
      this.foreignDir = realpathSync(mkdtempSync(join(cache, 'run-')))
    }
    this.foreignRepo = fakeForeignRepo(this.foreignDir, { branch, ownerRepo })
  }

  /**
   * Makes the next launch write the debug log of the session to a file in the folder of the scenario, so a step can read what
   * the mod wrote with `$.ui.log(…, { to: 'debug' })` (issue #193). The file starts empty: a step never passes on a line of an
   * earlier run. Before the session starts: the flags of a running session cannot change.
   */
  enableDebugLog(): void {
    if (this.launched) throw new Error('debug log: enable it before the step that starts the session')
    this.debugLog = join(this.outDir, 'debug.log')
    writeFileSync(this.debugLog, '')
  }

  /**
   * Makes a probe plugin in a folder of its own and keeps it for the next launch and for the cleanup (`tearDown`). Before the
   * session starts: the plugins of a running session cannot change. `label` names the probe in the error and in the folder.
   */
  private installProbe<T extends { pluginDir: string }>(label: string, write: (dir: string) => T): T {
    if (this.launched) throw new Error(`${label}: install it before the step that starts the session`)
    const dir = mkdtempSync(join(tmpdir(), `cc-${label.replaceAll(' ', '-')}-`))
    try {
      const probe = write(dir)
      this.probes.push({ dir, pluginDir: probe.pluginDir })
      return probe
    } catch (error) {
      rmSync(dir, { recursive: true, force: true }) // a probe that could not be written leaves no folder
      throw error
    }
  }

  /**
   * Adds the copy probe to the next launch: a plugin that answers `ui.copy` without writing the clipboard and logs the text.
   * Before the session starts: the plugins of a running session cannot change. The scenario removes it at the end.
   */
  installCopyProbe(): void {
    if (this.copyProbe !== undefined) return
    this.copyProbe = this.installProbe('copy probe', writeCopyProbe)
  }

  /**
   * Adds a probe plugin to the next launch that denies the `clock.after` of `ms` and passes every other delay, and counts what
   * it refused (issue #193). Before the session starts: the plugins of a running session cannot change. The scenario removes it
   * at the end. A scenario has one refuser: a second step with another delay throws, a second step with the same delay
   * changes nothing.
   */
  installTimerRefuser(ms: number): void {
    const refusal = timerRefuserRefusal(this.timerRefuser, ms)
    if (refusal !== undefined) throw new Error(refusal)
    if (this.timerRefuser !== undefined) return
    this.timerRefuser = this.installProbe('timer refuser', dir => writeTimerRefuser(dir, ms))
  }

  get tl(): Timeline {
    if (this.timeline === undefined) throw new Error('world: setUp did not run')
    return this.timeline
  }

  async setUp(name: string): Promise<void> {
    const { record, cols, rows, dir } = this.config
    if (record && ++recordedScenarios > 1) throw new Error('demo: only one @demo scenario can be recorded per run')
    this.outDir = outDirOf(this.config, record ? 'demo' : slug(name))
    this.release = await claimRun(lockDirOf(this.config), this.outDir)
    this.configDir = makeConfigDir(tmpdir())
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

  /** Gives the scenario another terminal size than DEMO_COLS and DEMO_ROWS, before the session starts (support/size.ts). */
  setTerminalSize(cols: number, rows: number): void {
    const refusal = sizeRefusal({ record: this.config.record, launched: this.launched })
    if (refusal !== undefined) throw new Error(refusal)
    this.tl.phase('cut')
    this.tmux.resize(cols, rows)
  }

  /**
   * Gives the path of the config file this width, before the session starts and before the config file is written
   * (support/config-dir.ts). The folder is made again, so `configDir` is the new one and the old one is gone.
   */
  setConfigPathWidth(cells: number): void {
    const refusal = pathWidthRefusal({
      launched: this.launched,
      written: existsSync(join(this.configDir, CONFIG_FILE)),
    })
    if (refusal !== undefined) throw new Error(refusal)
    this.tl.phase('cut')
    const next = makeConfigDir(tmpdir(), cells) // Throws first when the width is too small: the old folder stays.
    rmSync(this.configDir, { recursive: true, force: true })
    this.configDir = next
  }

  async launch(prompt?: string, tools?: readonly string[]): Promise<void> {
    this.launched = true
    this.tl.phase('cut')
    await launchClaude(
      {
        tmux: this.tmux,
        signalFile: this.signalFile,
        pluginDir: PLUGIN_DIR,
        extraPluginDirs: this.probes.map(probe => probe.pluginDir),
        ...(this.debugLog === undefined ? {} : { debugFile: this.debugLog }),
        model: this.config.model,
        timeoutMs: this.config.turnTimeoutMs,
        ...(tools ? { tools } : {}),
        env: {
          CLAUDE_TRACKER_CONFIG_DIR: this.configDir,
          ...(this.fakeGh ? fakeGhEnv(this.fakeGhFiles) : {}),
          ...(this.fakeApi ? fakeApiEnv(this.fakeApi.url, this.fakeHome) : {}),
        },
        ...(this.fakeApi ? { unset: PARENT_SESSION_VARS } : {}),
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
        if (this.fakeHome !== '') rmSync(this.fakeHome, { recursive: true, force: true })
        for (const probe of this.probes) rmSync(probe.dir, { recursive: true, force: true })
        if (this.foreignDir !== '') rmSync(this.foreignDir, { recursive: true, force: true })
      }
      await this.fakeApi?.close()
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

// The last scenario is done: leave the queue of runs now, so a run that waits behind this one does not wait for the process
// to end. A process that lingers after the last scenario (an open handle) would hold the queue until then.
AfterAll(() => {
  claimRun.leave()
})

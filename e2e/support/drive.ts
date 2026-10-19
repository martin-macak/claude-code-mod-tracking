import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLONE_NAME, loadConfig, OUT_DIR, PLUGIN_DIR, REPO_ROOT } from './config.ts'
import { countLines, launchClaude, prepareClone, waitForTurnEnd } from './session.ts'
import { Tmux } from './tmux.ts'

export type DriveCommand =
  | { cmd: 'start'; prompt?: string }
  | { cmd: 'type' | 'key' | 'caption'; text: string }
  | { cmd: 'wait-turn' | 'screen' | 'stop' }

export const DRIVE_USAGE =
  'usage: node bin/drive.ts start [prompt] | type <text> | key <name> | wait-turn | screen | caption <text> | stop'

export function parseDriveArgs(argv: string[]): DriveCommand {
  const [cmd, ...rest] = argv
  const text = rest.join(' ')
  switch (cmd) {
    case 'start':
      return text === '' ? { cmd } : { cmd, prompt: text }
    case 'type':
    case 'key':
    case 'caption':
      if (text === '') throw new Error(DRIVE_USAGE)
      return { cmd, text }
    case 'wait-turn':
    case 'screen':
    case 'stop':
      return { cmd }
    default:
      throw new Error(DRIVE_USAGE)
  }
}

type State = { signalFile: string; turnMark: number; dir: string; configDir: string }

const DRIVE_DIR = join(OUT_DIR, 'drive')
const STATE_FILE = join(DRIVE_DIR, 'state.json')
const tmux = new Tmux('cc-demo-drive')

function readState(): State {
  if (!existsSync(STATE_FILE)) throw new Error('drive: no session, run "start" first')
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State
}

const writeState = (state: State) => writeFileSync(STATE_FILE, JSON.stringify(state))

// One process per command. The tmux server keeps the claude session alive between commands.
export async function drive(command: DriveCommand): Promise<string> {
  const config = loadConfig({ ...process.env, DEMO_DIR: process.env.DEMO_DIR || '/tmp/cc-demo-drive' })
  switch (command.cmd) {
    case 'start': {
      if (existsSync(STATE_FILE)) throw new Error('drive: a session is running, run "stop" first')
      mkdirSync(DRIVE_DIR, { recursive: true })
      const configDir = mkdtempSync(join(tmpdir(), 'cc-tracker-config-')) // as in the world: no run touches the real file
      const state: State = { signalFile: join(DRIVE_DIR, 'signal'), turnMark: 0, dir: config.dir, configDir }
      rmSync(state.signalFile, { force: true })
      const clone = prepareClone(REPO_ROOT, config.dir)
      tmux.start({ cols: config.cols, rows: config.rows, cwd: clone, confDir: DRIVE_DIR })
      writeState(state)
      await launchClaude(
        {
          tmux,
          signalFile: state.signalFile,
          pluginDir: PLUGIN_DIR,
          model: config.model,
          timeoutMs: config.turnTimeoutMs,
          env: { CLAUDE_TRACKER_CONFIG_DIR: configDir },
        },
        command.prompt,
      )
      return tmux.capture()
    }
    case 'type': {
      const state = readState()
      writeState({ ...state, turnMark: countLines(state.signalFile) })
      await tmux.type(command.text, config.typeDelayMs)
      tmux.key('Enter')
      return ''
    }
    case 'key':
      tmux.key(command.text)
      return ''
    case 'caption':
      tmux.caption(command.text)
      return ''
    case 'wait-turn': {
      const state = readState()
      await waitForTurnEnd(state.signalFile, state.turnMark, config.turnTimeoutMs, () => tmux.capture())
      return tmux.capture()
    }
    case 'screen':
      return tmux.capture()
    case 'stop': {
      const state = existsSync(STATE_FILE) ? readState() : undefined
      tmux.kill()
      rmSync(join(state?.dir ?? config.dir, CLONE_NAME), { recursive: true, force: true })
      if (state?.configDir) rmSync(state.configDir, { recursive: true, force: true }) // absent in a state file of an older run
      rmSync(STATE_FILE, { force: true })
      return ''
    }
  }
}

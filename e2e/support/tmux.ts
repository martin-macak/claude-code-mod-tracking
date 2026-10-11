import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from './wait.ts'

// The status line is the caption bar. Claude Code must not rename the window or set the title.
export const TMUX_CONF = `${[
  'set -g default-shell /bin/sh',
  'set -g default-terminal xterm-256color',
  "set -ga terminal-features ',xterm-256color:RGB'",
  'set -g escape-time 0',
  // Without it, Claude Code shows a "tmux focus-events" notice next to the band.
  'set -g focus-events on',
  'set -g status on',
  'set -g status-position top',
  "set -g status-style 'bg=colour237,fg=colour231,bold'",
  "set -g status-left ''",
  "set -g status-right ''",
  "set -g status-format[0] '#[align=centre]#{@caption}'",
  'set -g set-titles off',
  'set -g allow-rename off',
  'set -g allow-set-title off',
].join('\n')}\n`

// tmux reads a ";" at the end of an argument as a command separator. "\;" keeps it literal.
export function tmuxLiteral(text: string): string {
  return text.endsWith(';') ? `${text.slice(0, -1)}\\;` : text
}

export type TmuxStart = { cols: number; rows: number; cwd: string; confDir: string }

export class Tmux {
  readonly socket: string
  readonly target = 'demo'

  constructor(socket: string) {
    this.socket = socket
  }

  // -u: UTF-8 even when make runs without a UTF-8 LANG. The Claude UI draws boxes.
  run(args: string[]): string {
    return execFileSync('tmux', ['-u', '-L', this.socket, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  // One extra row for the status line. The pane shell gets a neutral prompt and no rc file.
  start(opts: TmuxStart): void {
    const conf = join(opts.confDir, 'tmux.conf')
    writeFileSync(conf, TMUX_CONF)
    const { ENV: _rcFile, ...inherited } = process.env
    const env = { ...inherited, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    execFileSync(
      'tmux',
      [
        '-u',
        '-L',
        this.socket,
        '-f',
        conf,
        'new-session',
        '-d',
        '-s',
        this.target,
        '-x',
        String(opts.cols),
        '-y',
        String(opts.rows + 1),
        '-c',
        opts.cwd,
        '-e',
        'COLORTERM=truecolor',
        // tmux runs this through default-shell (/bin/sh, a non-interactive bash), which drops PS1.
        // So set it again for the interactive shell.
        "exec env 'PS1=$ ' /bin/sh",
      ],
      { stdio: 'ignore', env },
    )
    this.run(['set-option', '-t', this.target, '@caption', ''])
  }

  caption(text: string): void {
    this.run(['set-option', '-t', this.target, '@caption', text.replaceAll('#[', '##[')])
    for (const client of this.clients()) this.run(['refresh-client', '-S', '-t', client])
  }

  captionValue(): string {
    return this.run(['show-options', '-v', '-t', this.target, '@caption']).replace(/\n$/, '')
  }

  async type(text: string, delayMs: number): Promise<void> {
    for (const ch of text) {
      this.run(['send-keys', '-t', this.target, '-l', tmuxLiteral(ch)])
      await sleep(delayMs)
    }
  }

  line(text: string): void {
    this.run(['send-keys', '-t', this.target, '-l', tmuxLiteral(text)])
    this.key('Enter')
  }

  // Replaces the pane shell with the command. Nothing echoes the command line, so its paths
  // never reach the recording.
  respawn(command: string): void {
    this.run(['respawn-pane', '-k', '-t', this.target, command])
  }

  key(name: string): void {
    this.run(['send-keys', '-t', this.target, name])
  }

  capture(): string {
    return this.run(['capture-pane', '-p', '-t', this.target])
  }

  clients(): string[] {
    return this.run(['list-clients', '-F', '#{client_name}']).split('\n').filter(Boolean)
  }

  detachAll(): void {
    try {
      this.run(['detach-client', '-s', this.target])
    } catch {
      // No client attached.
    }
  }

  kill(): void {
    try {
      this.run(['kill-server'])
    } catch {
      // The server is already gone.
    }
  }
}

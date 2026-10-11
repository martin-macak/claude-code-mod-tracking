import { type ChildProcess, spawn } from 'node:child_process'
import type { Tmux } from './tmux.ts'
import { sleep, waitUntil } from './wait.ts'

export type RecordOptions = { castFile: string; cols: number; rows: number }

// asciinema records a tmux client, so the cast holds the caption bar and the pane, nothing else.
export class Recorder {
  private readonly binary: string
  private child: ChildProcess | undefined
  private exited: Promise<void> | undefined
  private failure: Error | undefined

  constructor(binary = 'asciinema') {
    this.binary = binary
  }

  async start(tmux: Tmux, opts: RecordOptions): Promise<void> {
    const attach = `tmux -u -L ${tmux.socket} attach -t ${tmux.target}`
    const child = spawn(
      this.binary,
      [
        'rec',
        '--headless',
        '--overwrite',
        '-f',
        'asciicast-v2',
        '--window-size',
        `${opts.cols}x${opts.rows + 1}`,
        '-c',
        attach,
        opts.castFile,
      ],
      { stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color' } },
    )
    this.child = child
    // 'close' also fires when the binary is missing; 'exit' does not.
    this.exited = new Promise(resolve => child.on('close', () => resolve()))
    child.on('error', err => {
      this.failure = err
    })
    await waitUntil(
      () => {
        if (this.failure) throw new Error(`recorder: asciinema failed to start: ${this.failure.message}`)
        return tmux.clients().length > 0 ? true : undefined
      },
      { timeoutMs: 10_000, intervalMs: 50, what: 'asciinema to attach to tmux' },
    )
  }

  async stop(tmux: Tmux): Promise<void> {
    const { child, exited } = this
    if (child === undefined || exited === undefined) return
    this.child = undefined
    this.exited = undefined
    if (child.pid === undefined) return // it never ran
    tmux.detachAll()
    const timedOut = await Promise.race([exited.then(() => false), sleep(10_000).then(() => true)])
    if (timedOut) {
      child.kill('SIGTERM')
      await exited
    }
  }
}

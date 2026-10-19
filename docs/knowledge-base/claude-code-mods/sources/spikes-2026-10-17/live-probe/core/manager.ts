import type { Ports } from './ports'

/** Lives in a SIBLING folder of hooks/ (G19). Takes a ports object (G02). */
export class Manager {
  ticks = 0
  bumpOk = 0
  bumpErrors: string[] = []
  afterFired = 0
  sid = ''
  constructor(private readonly ports: Ports) {}

  async start(): Promise<void> {
    this.sid = await this.ports.session.id()
    await this.ports.store.set('live-probe:started', { sid: this.sid })
    this.ports.clock.after(500, () => {
      this.afterFired++
    })
    this.ports.clock.every(200, () => {
      this.ticks++
      this.ports.state.bump().then(
        () => {
          this.bumpOk++
        },
        err => {
          this.bumpErrors.push(String((err as { message?: string })?.message ?? err))
        },
      )
    })
  }

  stateGet(): Promise<number> {
    return this.ports.state.get()
  }

  rawGet() {
    return this.ports.state.rawGet()
  }
  rawSet(v: number) {
    return this.ports.state.rawSet(v)
  }
  armRawSetAfter(ms: number, v: number, sink: unknown[]) {
    this.ports.clock.after(ms, () => {
      this.ports.state.rawSet(v).then(r => sink.push({ setFromPortsTimer: r }), err => sink.push({ err: String(err) }))
    })
  }

  /** Arms a one-shot bump FROM the caller's context (a hook), through the stored ports. */
  armBump(ms: number, sink: unknown[], tag: string): void {
    this.ports.clock.after(ms, () => {
      this.ports.state.bump().then(r => sink.push({ [tag]: r }), err => sink.push({ [tag + '_err']: String(err) }))
    })
  }

  async report(outPath: string): Promise<Record<string, unknown>> {
    const r = await this.ports.run(['echo', 'ports.run-ok'])
    const o: Record<string, unknown> = {
      bumpOk: this.bumpOk,
      bumpErrors: this.bumpErrors.slice(0, 3),
      sid: this.sid,
      ticks: this.ticks,
      afterFired: this.afterFired,
      store: await this.ports.store.get('live-probe:started'),
      run: r.stdout.trim(),
      cwd: await this.ports.session.cwd(),
      now: await this.ports.clock.now(),
    }
    await this.ports.fs.write(outPath, JSON.stringify(o))
    o.fsExists = await this.ports.fs.exists(outPath)
    return o
  }
}

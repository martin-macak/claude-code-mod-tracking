import type { Ports } from './ports'

/** A class from another file. It holds the ports and uses them later: from timers and from other events. */
export class Manager {
  ticks = 0
  afterFired = 0
  constructor(private readonly ports: Ports) {}

  async start(): Promise<void> {
    const id = await this.ports.session.id()
    await this.ports.store.set('g02:started', { id })
    await this.ports.fs.write('/cfg/started.txt', id)
    // Timers that outlive the hook that armed them.
    this.ports.clock.after(1000, () => {
      this.afterFired++
      void this.tick('after')
    })
    this.ports.clock.every(500, () => {
      void this.tick('every')
    })
  }

  async tick(why: string): Promise<void> {
    this.ticks++
    await this.ports.state.bump()
    await this.ports.store.set('g02:ticks', { n: this.ticks, why, at: await this.ports.clock.now() })
  }

  /** Called from a LATER event (tool.call). */
  async onTool(): Promise<string> {
    const r = await this.ports.run(['echo', 'hi'])
    const n = await this.ports.state.get()
    const cfg = await this.ports.fs.read('/cfg/started.txt')
    const has = await this.ports.fs.exists('/cfg/started.txt')
    const stored = await this.ports.store.get('g02:ticks')
    return JSON.stringify({ run: r.stdout.trim(), state: n, cfg, has, ticks: this.ticks, stored })
  }
}

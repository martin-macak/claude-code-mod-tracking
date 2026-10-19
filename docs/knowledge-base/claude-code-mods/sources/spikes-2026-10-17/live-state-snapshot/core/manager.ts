import type { Ports } from './ports'

/** One question: what does a hook that sleeps see of state written by timers armed elsewhere? */
export class Manager {
  bumpOk = 0
  constructor(private readonly ports: Ports) {}

  start(): void {
    // Armed in session.start. Lands one bump at +100 ms.
    this.ports.clock.after(100, () => {
      this.ports.state.bump().then(() => {
        this.bumpOk++
      })
    })
  }

  /** Arms a one-shot bump from the CALLER's context (a hook), through the ports built in session.start. */
  armBump(ms: number, sink: unknown[], tag: string): void {
    this.ports.clock.after(ms, () => {
      this.ports.state.bump().then(r => sink.push({ [tag]: r }), err => sink.push({ [tag + '_err']: String(err) }))
    })
  }
}

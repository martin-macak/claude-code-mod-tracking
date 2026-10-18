import type { EngineInterface, Register } from 'claude-code'

type ClockPort = { now(): Promise<number>; after(ms: number, fn: () => void): unknown }
type StorePort = { get(key: string): Promise<unknown>; set(key: string, v: unknown): Promise<void> }

function portsOf($: EngineInterface): { clock: ClockPort; store: StorePort } {
  // Method shorthand, a nested function declaration, and a getter: three ways a port may close over `$`.
  function stamp(): Promise<number> {
    return $.clock.now()
  }
  return {
    clock: {
      now() {
        return stamp()
      },
      after(ms, fn) {
        return $.clock.after(ms, fn)
      },
    },
    store: {
      get(key) {
        return $.store.get(key)
      },
      async set(key, v) {
        await $.store.set(key, v)
      },
    },
  }
}

class Svc {
  constructor(private readonly p: ReturnType<typeof portsOf>) {}
  async go(): Promise<string> {
    await this.p.store.set('k', { t: await this.p.clock.now() })
    return JSON.stringify(await this.p.store.get('k'))
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ deny: await new Svc(portsOf($)).go() }))
}

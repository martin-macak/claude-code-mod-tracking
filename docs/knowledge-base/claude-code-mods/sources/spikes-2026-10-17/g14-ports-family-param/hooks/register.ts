import type { EngineInterface, Register } from 'claude-code'
import { github, jira, type SlotPort } from '../trackers/a'

const TRACKERS = [github, jira] as const

function portsOf($: EngineInterface): SlotPort {
  return {
    get: async id => (await $.state.get({ plugin: 'g14', key: 'slots', id } as const)).value,
    set: async (id, v) => { await $.state.set({ plugin: 'g14', key: 'slots', id } as const, v) },
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const p = portsOf($)
    const out: string[] = []
    for (const t of TRACKERS) out.push(await t.onBash(p))
    return { deny: out.join(' ') }
  })
}

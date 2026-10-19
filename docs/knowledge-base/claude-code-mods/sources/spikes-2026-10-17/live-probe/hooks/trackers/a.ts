import type { On } from 'claude-code'
import { read, update } from 'claude-code'
import { holder, OUT } from '../../core/holder'


export function installA(on: On): void {
  on('command.run', { command: 'spike' }, async ($, e, next) => {
    // G13: family members, id from the tracker, refs are literals with a computed id.
    await update($, { plugin: 'live-probe', key: 'slots', id: 'github' } as const, v => ({ n: ((v as { n?: number } | undefined)?.n ?? 0) + 1 }))
    await update($, { plugin: 'live-probe', key: 'slots', id: 'github' } as const, v => ({ n: ((v as { n?: number } | undefined)?.n ?? 0) + 1 }))
    await update($, { plugin: 'live-probe', key: 'slots', id: 'jira' } as const, v => ({ n: ((v as { n?: number } | undefined)?.n ?? 0) + 10 }))
    const gh = await read($, { plugin: 'live-probe', key: 'slots', id: 'github' } as const)
    const jira = await read($, { plugin: 'live-probe', key: 'slots', id: 'jira' } as const)
    await $.clock.sleep(1000) // let the timers armed by session.start run
    const rep = (await holder.manager?.report(OUT + '/ports.json')) ?? { error: 'no manager' }
    const result = { slots: { github: gh, jira }, ports: rep, trackerA: 'hook-in-imported-file-ran' }
    await $.fs.write(OUT + '/result.json', JSON.stringify(result, null, 1))
    return { text: 'spike done' }
  })
}

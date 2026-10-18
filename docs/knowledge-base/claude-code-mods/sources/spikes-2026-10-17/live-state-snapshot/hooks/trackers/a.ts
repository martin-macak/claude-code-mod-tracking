import type { On } from 'claude-code'
import { holder, OUT } from '../../core/holder'

export function installA(on: On): void {
  on('command.run', { command: 'spike' }, async ($, e, next) => {
    const ref = { plugin: 'live-probe', key: 'hits' } as const
    const log: unknown[] = []
    log.push({ t0_get: await $.state.get(ref) })
    await $.clock.sleep(500) // the session.start timer (after 100) has run and its update resolved
    log.push({ t1_get_after_sessionStartTimer: await $.state.get(ref), mgr_bumpOk: holder.manager?.bumpOk })
    holder.manager?.armBump(100, log, 'cmdArmedTimerBump') // armed in THIS hook, closure from session.start's $
    await $.clock.sleep(500)
    log.push({ t2_get_after_cmdArmedTimer: await $.state.get(ref) })
    await $.fs.write(OUT + '/result.json', JSON.stringify(log, null, 1))
    return { text: 'snapshot probe done' }
  })
}

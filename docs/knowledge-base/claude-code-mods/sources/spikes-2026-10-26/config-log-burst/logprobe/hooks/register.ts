// Scratch probe: send N problem-like lines to the debug log with $.ui.log, B lines per call, and report the loop time.
import type { Register } from 'claude-code'
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const n = Number((await $.env.get('PROBE_KEYS' as never)) ?? '0')
    const b = Number((await $.env.get('PROBE_BATCH' as never)) ?? '1')
    const t0 = Date.now()
    let buf: string[] = []
    for (let i = 0; i < n; i++) {
      buf.push(`probe: global.k${i}: unknown key. The mod keeps it and ignores it.`)
      if (buf.length >= b) {
        $.ui.log(buf.join('\n'), { to: 'debug' })
        buf = []
      }
    }
    if (buf.length > 0) $.ui.log(buf.join('\n'), { to: 'debug' })
    $.ui.log(`probe: loop done n=${n} batch=${b} loopMs=${Date.now() - t0}`, { to: 'debug' })
    return next(e)
  })
}

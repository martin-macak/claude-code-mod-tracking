import type { EngineInterface, Register } from 'claude-code'

function portsOf($: EngineInterface) {
  return {
    home: () => $.env.get('HOME'),
    xdg: () => $.env.get('XDG_CONFIG_HOME'),
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const p = portsOf($)
    await p.home()
    await p.xdg()
    return next(e)
  })
}

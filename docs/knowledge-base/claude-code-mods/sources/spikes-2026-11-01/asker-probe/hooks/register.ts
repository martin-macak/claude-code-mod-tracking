// Spike for issue #208: /askme calls $.ui.ask and logs what it got.
export const register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'askme', description: 'spike: ui.ask' })
    return next(e)
  })
  on('command.run', { command: 'askme' }, async ($, e) => {
    let text
    try {
      const picked = await $.ui.ask('Which colour?', { options: ['Red', 'Blue'], header: 'Colour' })
      text = 'asker got: ' + JSON.stringify(picked)
    } catch (err) {
      text = 'asker threw: ' + String(err?.message ?? err)
    }
    await $.fs.write('<SPIKES>/out/asker.log', text + '\n')
    return { text }
  })
}

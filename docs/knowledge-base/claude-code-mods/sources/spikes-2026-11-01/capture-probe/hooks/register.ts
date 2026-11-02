// Spike for issue #208: write what a tool.call hook sees of AskUserQuestion, before the dialog and after it.
export const register = on => {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion') return next(e)
    const started = Date.now()
    let ran = null
    let threw
    try {
      ran = await next(e)
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    await $.fs.write(
      '<SPIKES>/out/' + e.tool + '-' + String(e.toolUseId ?? e.tool_use_id) + '.json',
      JSON.stringify({ tool: e.tool, startedAt: started, endedAt: Date.now(), input: e, ran, threw }, null, 2),
    )
    if (threw !== undefined) throw new Error(threw)
    return ran
  })
}

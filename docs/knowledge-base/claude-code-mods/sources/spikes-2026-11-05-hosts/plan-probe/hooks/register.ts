// Spike for issue #312: write what a tool.call hook sees of ExitPlanMode and AskUserQuestion, before the dialog and after it.
// `<OUT>` stands for the folder of the captures: launch-plan.sh copies the probe and fills it in.
export const register = on => {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'ExitPlanMode' && e.tool !== 'AskUserQuestion') return next(e)
    let ran = null
    let threw
    try {
      ran = await next(e)
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    await $.fs.write(
      `<OUT>/${e.tool}-${String(e.toolUseId ?? e.tool_use_id)}.json`,
      JSON.stringify({ tool: e.tool, input: e, ran, threw }, null, 2),
    )
    if (threw !== undefined) throw new Error(threw)
    return ran
  })
}

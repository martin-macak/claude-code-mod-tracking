// Spike for issue #71: write what a tool.call hook sees of AskUserQuestion, ExitPlanMode and EnterPlanMode.
import type { Register } from 'claude-code'

const OUT = '<SPIKES>/out'

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion' && e.tool !== 'ExitPlanMode' && e.tool !== 'EnterPlanMode') return next(e)
    const started = Date.now()
    let ran: unknown = null
    let threw: string | undefined
    try {
      ran = await next(e)
    } catch (err) {
      threw = String((err as { message?: string })?.message ?? err)
    }
    await $.fs.write(
      `${OUT}/${e.tool}-${String((e as { tool_use_id?: string }).tool_use_id)}.json`,
      JSON.stringify({ tool: e.tool, startedAt: started, endedAt: Date.now(), input: e, ran, threw }, null, 2),
    )
    if (threw !== undefined) throw new Error(threw)
    return ran as never
  })
}

import type { EngineInterface, Register } from 'claude-code'
const DIR = '<scratch>/out/'
let chain: Promise<void> = Promise.resolve()
function put($: EngineInterface, kind: string, data: unknown): Promise<void> {
  chain = chain.then(() => put1($, kind, data), () => put1($, kind, data))
  return chain
}
async function put1($: EngineInterface, kind: string, data: unknown): Promise<void> {
  try {
    const OUT = DIR + 'ev-' + (await $.session.id()).slice(0, 8) + '.jsonl'
    const prev = (await $.fs.exists(OUT)) ? await $.fs.read(OUT) : ''
    await $.fs.write(OUT, prev + JSON.stringify({ kind, at: await $.clock.now(), data }) + '\n')
  } catch (err) {
    /* ignore */
  }
}
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await put($, 'session.start', { cwd: e.cwd, id: await $.session.id() })
    try {
      const main = await $.session.messages()
      await put($, 'messages@session.start', main)
      for (const m of main)
        for (const u of m.toolUses ?? [])
          if (u.agentId !== undefined) {
            try {
              await put($, 'agent.messages@session.start', { agentId: u.agentId, out: await $.session.messages({ agentId: u.agentId }) })
            } catch (err) {
              await put($, 'agent.messages@session.start.err', { agentId: u.agentId, err: String(err) })
            }
          }
    } catch (err) {
      await put($, 'messages@session.start.err', String(err))
    }
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      try {
        const main = await $.session.messages()
        await put($, 'messages@turn.start', main)
        for (const m of main)
          for (const u of m.toolUses ?? [])
            if (u.agentId !== undefined) {
              try {
                await put($, 'agent.messages@turn.start', { agentId: u.agentId, out: await $.session.messages({ agentId: u.agentId }) })
              } catch (err) {
                await put($, 'agent.messages@turn.start.err', { agentId: u.agentId, err: String(err) })
              }
            }
      } catch (err) {
        await put($, 'messages@turn.start.err', String(err))
      }
    }
    return out
  })
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.tool === 'Bash')
      await put($, 'tool.call.Bash', { agentId: e.agentId, tool_use_id: e.tool_use_id, input: e, result: (r as any).result, text: (r as any).text, isError: (r as any).isError })
    return r
  })
}

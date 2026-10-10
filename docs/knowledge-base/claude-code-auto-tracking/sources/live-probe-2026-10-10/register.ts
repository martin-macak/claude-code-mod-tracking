import type { EngineInterface, Register } from 'claude-code'
const DIR = '/private/tmp/claude-501/-Users-user-projects-claude-code-mod-tracking/29484de1-cef4-4282-97e8-750e88984c88/scratchpad/out/'
let chain: Promise<void> = Promise.resolve()
function put($: EngineInterface, kind: string, data: unknown): Promise<void> {
  chain = chain.then(() => put1($, kind, data), () => put1($, kind, data))
  return chain
}
async function put1($: EngineInterface, kind: string, data: unknown): Promise<void> {
  try {
    const OUT = DIR + 'ev-' + ((await $.session.id()).slice(0, 8)) + '.jsonl'
    const prev = (await $.fs.exists(OUT)) ? await $.fs.read(OUT) : ''
    await $.fs.write(OUT, prev + JSON.stringify({ kind, at: await $.clock.now(), data }) + '\n')
  } catch (err) { /* ignore */ }
}
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await put($, 'session.start', { cwd: e.cwd, id: await $.session.id(), root: await $.session.root() })
    let last = ''
    const sid = await $.session.id()
    $.clock.every(1000, async () => {
      try {
        const list = await $.agent.list()
        const s = JSON.stringify(list)
        if (list.length > 0 && s !== last) { last = s; await put($, 'agent.list', list) }
      } catch (err) { await put($, 'agent.list.err', String(err)) }
      try {
        await $.store.set('p:' + sid, { cwd: await $.session.cwd(), at: await $.clock.now() })
        const keys = await $.store.keys()
        const vals: Record<string, unknown> = {}
        for (const k of keys) vals[k] = await $.store.get(k)
        await put($, 'store.view', { me: sid, keys, vals })
      } catch (err) { await put($, 'store.err', String(err)) }
    })
    let n = 0
    $.clock.every(3000, async () => {
      if (n++ > 2) return
      try { const r = await $.tool.call({ tool: 'ListAgents' } as any); await put($, 'ListAgents', { text: (r as any).text, result: (r as any).result, deny: (r as any).deny }) } catch (err) { await put($, 'ListAgents.err', String(err)) }
    })
    return next(e)
  })
  on('classic.WorktreeCreate', async ($, e, next) => {
    await put($, 'WorktreeCreate.in', e)
    const r = await next(e)
    await put($, 'WorktreeCreate.out', r)
    return r
  })
  on('classic.WorktreeRemove', async ($, e, next) => {
    await put($, 'WorktreeRemove.in', e)
    const r = await next(e)
    await put($, 'WorktreeRemove.out', r)
    return r
  })
  on('classic.SubagentStart', async ($, e, next) => { await put($, 'SubagentStart', e); return next(e) })
  on('classic.SubagentStop', async ($, e, next) => { await put($, 'SubagentStop', e); return next(e) })
  on('classic.CwdChanged', async ($, e, next) => { await put($, 'CwdChanged', e); return next(e) })
  on('classic.PostToolUse', async ($, e, next) => { await put($, 'PostToolUse', { tool: e.tool_name, cwd: e.cwd, agent_id: e.agent_id, agent_type: e.agent_type, input: e.tool_input, response: e.tool_response }); return next(e) })
  on('agent.spawn', async ($, e, next) => { await put($, 'agent.spawn', e); const r = await next(e); await put($, 'agent.spawn.out', r); return r })
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (['Bash','EnterWorktree','ExitWorktree','Agent'].includes(e.tool)) await put($, 'tool.call.' + e.tool, { agentId: e.agentId, input: e, result: (r as any).result, text: (r as any).text, isError: (r as any).isError })
    return r
  })
}

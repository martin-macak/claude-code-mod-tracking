// Observes every row `session.append` hands over and writes them to /tmp/row-logger.json.
// A scratch tool for the live checks in this folder, not a mod to keep. Attachments are logged by name only.
import type { EngineInterface, Register } from 'claude-code'

const LOG = '/tmp/row-logger.json'

const rows: unknown[] = []

async function save($: EngineInterface): Promise<void> {
  await $.fs.write(LOG, JSON.stringify(rows, null, 1))
}

export const register: Register = (on) => {
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const body = e.door === 'attachment' ? '(omitted)' : e.message.content
    rows.push({ door: e.door, origin: e.origin, agentId: e.agentId, uuid: e.uuid, type: e.message.type, name: e.message.name, role: e.message.role, isMeta: e.message.isMeta, content: body })
    await save($)
    return stored
  })
  on('turn.complete', async ($, e, next) => {
    rows.push({ turnComplete: { answer: e.answer, reason: e.reason, agentId: e.agentId } })
    await save($)
    return next(e)
  })
  on('session.start', async ($, e, next) => {
    const messages = await $.session.messages()
    rows.push({ sessionStart: { surface: e.surface, isInteractive: e.isInteractive, loaded: messages.length, messages: messages.map((m) => ({ role: m.role, text: m.text.slice(0, 160), toolUses: m.toolUses.length, toolResults: m.toolResults?.length })) } })
    await save($)
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    rows.push({ classicSessionStart: { source: e.source } }) // never logged on this machine: sec-default bypasses user-tier hooks of this event
    await save($)
    return next(e)
  })
}

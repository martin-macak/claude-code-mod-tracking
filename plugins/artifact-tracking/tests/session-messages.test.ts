// The `messages` port over the engine's session: the plain read, the read of one agent and the `{ deny }` answer (issue #247).
import { expect, test } from 'claude-code/testing'
import type { SessionRow } from '../core/interfaces/ports'
import { sessionMessages } from '../hooks/session-messages'

const ROW = { role: 'user', text: 'hi', toolUses: [] } as SessionRow

/** A stub of `$.session.messages` that answers what `answer` gives and records its arguments. */
const session = (answer: (o?: { agentId?: string }) => unknown) => {
  const calls: unknown[] = []
  return {
    calls,
    session: (async (o?: { agentId?: string }) => {
      calls.push(o)
      return answer(o)
    }) as never,
  }
}

test('with no agent id, the read is the plain read of the session', async () => {
  const s = session(() => [ROW])
  expect(await sessionMessages(s.session)).toEqual([ROW])
  expect(s.calls).toEqual([undefined])
  expect(await sessionMessages(s.session, {})).toEqual([ROW])
})

test('with an agent id, the read asks for that agent and gives its list', async () => {
  const s = session(() => [ROW])
  expect(await sessionMessages(s.session, { agentId: 'ag-1' })).toEqual([ROW])
  expect(s.calls).toEqual([{ agentId: 'ag-1' }])
})

test('a deny answer for an agent becomes a thrown error with its reason', async () => {
  const s = session(() => ({ deny: 'workflow agents are not readable' }))
  await expect(sessionMessages(s.session, { agentId: 'ag-1' })).rejects.toThrow('workflow agents are not readable')
})

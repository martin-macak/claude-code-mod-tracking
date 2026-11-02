// The `messages` port over the engine's session (issue #247). Own file: `register.tsx` touches `$` and no test loads it, so
// the `{ deny }` rule lives here, where a test can give it a stub of the engine read.

import type { SessionRow } from '../core/interfaces/ports'

/**
 * The messages of the session, or, with `agentId`, of one of its agents. An agent that the session cannot read answers
 * `{ deny }`, not a list: this throws its reason, and the replay logs it and skips that agent.
 */
export async function sessionMessages(
  read: (o?: { readonly agentId: string }) => Promise<readonly SessionRow[] | { readonly deny: string }>,
  o?: { readonly agentId?: string },
): Promise<readonly SessionRow[]> {
  if (o?.agentId === undefined) return (await read()) as readonly SessionRow[]
  const rows = await read({ agentId: o.agentId })
  if ('deny' in rows) throw new Error(rows.deny)
  return rows
}

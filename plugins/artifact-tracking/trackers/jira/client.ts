// The `acli` side of the jira tracker: its tool spec and its client over a handle. The tracker declares `ACLI_TOOL`;
// core builds the handle (probe, timeouts, breaker). A kind gets the client from the handle it was given: one
// `AcliTool` per handle, so the active site and the concurrency gate are shared.
// Plan: L5 Task 3, K13.

import type { ToolHandle, ToolSpec } from '../../core/interfaces/tracker'
import type { Now } from '../../hooks/contracts'
import { AcliTool } from './acli-tool'
import type { JiraConfig } from './config'

export const ACLI_TOOL: ToolSpec = { id: 'acli', probe: ['acli', '--version'] }

const clients = new WeakMap<ToolHandle, AcliTool>()

export function acliClient(
  handle: ToolHandle,
  d: { now: Now; limits: () => Pick<JiraConfig, 'concurrency' | 'epicChildLimit'> },
): AcliTool {
  let client = clients.get(handle)
  if (!client) {
    client = new AcliTool(handle, d.now, undefined, { limits: d.limits })
    clients.set(handle, client)
  }
  return client
}

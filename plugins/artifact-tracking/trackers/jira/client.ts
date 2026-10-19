// The `acli` side of the jira tracker: its tool spec and its client over a handle. The tracker declares `ACLI_TOOL`;
// core builds the handle (probe, timeouts, breaker). A kind gets the client from the handle it was given: one
// `AcliTool` per handle, so the active site and the concurrency gate are shared.
// Plan: L5 Task 3, K13.

import type { ConfigView } from '../../core/interfaces/config'
import type { JsonObject } from '../../core/interfaces/items'
import type { Now } from '../../core/interfaces/ports'
import type { ToolHandle, ToolPort, ToolSpec } from '../../core/interfaces/tracker'
import { AcliTool } from './acli-tool'
import { JIRA_DEFAULTS, type JiraConfig } from './config'

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

/**
 * The client over the `acli` handle the owning tracker declared, or undefined when there is no such handle. One client
 * per handle. The slice comes over the defaults, so a host with no spec for the tracker reads today's numbers.
 */
export function acliOf(tools: ToolPort, config: ConfigView<JsonObject>, now: Now): AcliTool | undefined {
  const handle = tools.handle(ACLI_TOOL.id)
  return (
    handle &&
    acliClient(handle, {
      now,
      limits: () => ({ ...JIRA_DEFAULTS, ...(config.slice() as unknown as Partial<JiraConfig>) }),
    })
  )
}

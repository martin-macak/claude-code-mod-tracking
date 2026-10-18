// The `gh` side of the github tracker: its tool spec and its client over a handle. The tracker declares `GH_TOOL`;
// core builds the handle (probe, timeouts, breaker). A kind or the PR lane gets the client from the handle it was
// given: one `GhTool` per handle, so the host cache and the repo lookup are shared.
// Plan: L5 Task 3, K13.

import type { ConfigView } from '../../core/interfaces/config'
import type { JsonObject } from '../../core/interfaces/items'
import type { Now } from '../../core/interfaces/ports'
import type { ToolHandle, ToolPort, ToolSpec } from '../../core/interfaces/tracker'
import { GITHUB_DEFAULTS, type GithubConfig } from './config'
import { GhTool } from './gh-tool'

export const GH_TOOL: ToolSpec = { id: 'gh', probe: ['gh', '--version'] }

const clients = new WeakMap<ToolHandle, GhTool>()

export function ghClient(
  handle: ToolHandle,
  d: { now: Now; limits: () => Pick<GithubConfig, 'chunkSize' | 'closingRefsPerPr' | 'discoveryTimeoutMs'> },
): GhTool {
  let client = clients.get(handle)
  if (!client) {
    client = new GhTool(handle, d.now, undefined, { limits: d.limits })
    clients.set(handle, client)
  }
  return client
}

/**
 * The client over the `gh` handle the owning tracker declared, or undefined when there is no such handle. One client
 * per handle: the first caller's clock and limits stay, and every caller reads the same live config and clock.
 * The slice comes over the defaults, so a host with no spec for the tracker reads today's numbers.
 */
export function ghOf(tools: ToolPort, config: ConfigView<JsonObject>, now: Now): GhTool | undefined {
  const handle = tools.handle(GH_TOOL.id)
  return (
    handle &&
    ghClient(handle, {
      now,
      limits: () => ({ ...GITHUB_DEFAULTS, ...(config.slice() as unknown as Partial<GithubConfig>) }),
    })
  )
}

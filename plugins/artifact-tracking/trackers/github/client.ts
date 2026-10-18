// The `gh` side of the github tracker: its tool spec and its client over a handle. The tracker declares `GH_TOOL`;
// core builds the handle (probe, timeouts, breaker). A kind or the PR lane gets the client from the handle it was
// given: one `GhTool` per handle, so the host cache and the repo lookup are shared.
// Plan: L5 Task 3, K13.

import type { ToolHandle, ToolSpec } from '../../core/interfaces/tracker'
import type { Now } from '../../hooks/contracts'
import type { GithubConfig } from './config'
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

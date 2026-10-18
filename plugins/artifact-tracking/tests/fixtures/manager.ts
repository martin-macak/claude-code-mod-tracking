// A LifecycleManager over a real ItemRuntime and the real tracker list, on fakePorts. The tests of `/track`, the pane
// actions and the artifact and file trackers use it: they need the whole chain (the start sequence, the bus, the item
// host and the slots), with no engine and no `$`. `extra` adds trackers after the real ones, e.g. a recorder.

import { LifecycleManager } from '../../core/infra/lifecycle'
import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { GLOBAL_DEFAULTS } from '../../core/lib/global-config'
import type { ItemRecord } from '../../hooks/contracts'
import { ItemRuntime } from '../../hooks/items/runtime'
import { buildTrackers } from '../../trackers'
import { autoDismiss } from '../../trackers/auto/dismiss-store'
import { ghAcliRun, type ItemsOpts } from './items'
import { type FakeOpts, fakePorts } from './ports'

export type ManagerOpts = ItemsOpts & {
  trackers?: (rt: ItemRuntime) => readonly Tracker[]
  extra?: readonly Tracker[]
  fake?: FakeOpts
}

export function managerWorld(o: ManagerOpts = {}) {
  const w = fakePorts({
    ...o.fake,
    session: {
      cwd: '/work',
      repo: o.remote === undefined ? { host: 'github.com', owner: 'acme', repo: 'web' } : o.remote,
      ...o.fake?.session,
    },
  })
  w.run = ghAcliRun(o)
  const rt = new ItemRuntime(w.ports.state)
  const trackers = o.trackers ? o.trackers(rt) : buildTrackers({ autoGithub: rt.autoGithub })
  const m = new LifecycleManager(
    {
      trackers: [...trackers, ...(o.extra ?? [])],
      items: rt,
      dismiss: p => autoDismiss(p.state.slot),
      global: GLOBAL_DEFAULTS,
      paneId: 'track',
    },
    w.ports,
  )
  const items = () => (w.state.get('items') ?? []) as unknown as ItemRecord[]
  const keys = () => items().map(r => r.key)
  /** One finished tool call, as the manager hears it. */
  const call = (tool: string, input: Record<string, unknown>, result: unknown, extra: Partial<ToolCallEvent> = {}) =>
    m.toolCall(w.ports, { tool, input: { tool, ...input } as Json, result: (result ?? null) as Json, ...extra })
  return { w, rt, m, items, keys, call }
}

// A LifecycleManager over its own ItemService and the real tracker list, on fakePorts. The tests of `/track`, the pane
// actions and the artifact and file trackers use it: they need the whole chain (the start sequence, the bus, the item
// host, the router and the slots), with no engine and no `$`. `extra` adds trackers after the real ones, e.g. a recorder.
// The `/track` list and help text are the texts of the sections, as register.tsx injects them.

import { LifecycleManager } from '../../core/infra/lifecycle'
import type { ConfigService } from '../../core/interfaces/config'
import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { helpTextOf, listText, turnLabels } from '../../hooks/pane-session'
import { TRACKERS } from '../../trackers'
import { autoDismiss } from '../../trackers/auto/dismiss-store'
import { fakeConfig } from './config-fs'
import type { ItemRecord } from './contracts'
import { ghAcliRun, type ItemsOpts } from './items'
import { type FakeOpts, fakePorts } from './ports'

export type ManagerOpts = ItemsOpts & {
  trackers?: () => readonly Tracker[]
  extra?: readonly Tracker[]
  fake?: FakeOpts
  /** The config over the trackers of this world. Default: `fakeConfig({ specs })`, no problem, every tracker on. */
  config?: (specs: readonly Tracker[]) => ConfigService
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
  let m: LifecycleManager | undefined
  const trackers = [...(o.trackers ? o.trackers() : TRACKERS), ...(o.extra ?? [])]
  const cfg = (o.config ?? (specs => fakeConfig({ specs })))(trackers)
  m = new LifecycleManager(
    {
      trackers,
      dismiss: p => autoDismiss(p.state.slot),
      config: () => cfg,
      paneId: 'track',
      listText: p => listText(p, m as LifecycleManager),
      helpText: p => helpTextOf(p, m as LifecycleManager),
      turnLabels: p => turnLabels(p, m as LifecycleManager),
    },
    w.ports,
  )
  const rt = m.items
  const items = () => (w.state.get('items') ?? []) as unknown as ItemRecord[]
  const keys = () => items().map(r => r.key)
  /** One finished tool call, as the manager hears it. */
  const call = (tool: string, input: Record<string, unknown>, result: unknown, extra: Partial<ToolCallEvent> = {}) =>
    m.toolCall(w.ports, { tool, input: { tool, ...input } as Json, result: (result ?? null) as Json, ...extra })
  const manager = m
  return { w, rt, m: manager, cfg, items, keys, call }
}

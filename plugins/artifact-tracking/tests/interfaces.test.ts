// The core interfaces compile and a plain object can implement them. The real check is `tsc`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8.
import { expect, test } from 'claude-code/testing'
import type { Tracker, TrackerContext } from '../core/interfaces/tracker'

test('a minimal tracker satisfies Tracker and joins a Tracker list', () => {
  const fake = {
    id: 'fake',
    order: 99,
    config: { defaults: {}, normalise: raw => raw },
    init: () => {},
    store: ctx => ctx.config.slice(),
  } satisfies Tracker

  const ctx = { config: { slice: () => ({}) } } as unknown as TrackerContext
  expect(fake.store(ctx)).toEqual({})

  // A tracker with its own config and data types must fit the registration list (spec 5.8).
  type DemoConfig = { enabled: boolean; limit: number }
  const demo = {
    id: 'demo',
    order: 1,
    config: { defaults: { enabled: true, limit: 5 }, normalise: (_raw, defaults) => defaults },
    events: {
      agentSpawn: ctx => void ctx.config.slice().limit,
      toolCall: { Read: (ctx, e) => void [ctx.config.slice().limit, e.tool] },
      tick: { run: ctx => void ctx.config.slice().limit },
    },
    init: ctx => void ctx.data.get(),
    store: ctx => ctx.config.slice(),
    sections: ctx => [{ id: 'demo', title: `Demo ${ctx.config.slice().limit}`, columns: [], rows: [] }],
  } satisfies Tracker<DemoConfig, number>
  const trackers: readonly Tracker[] = [fake, demo]
  expect(trackers.map(t => t.id)).toEqual(['fake', 'demo'])
})

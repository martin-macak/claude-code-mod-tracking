// The core interfaces compile and a plain object can implement them. The real check is `tsc`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8.
import { expect, test } from 'claude-code/testing'
import type {
  CoreReason as ItemsCoreReason,
  ReasonSet as ItemsReasonSet,
  Json,
  JsonObject,
} from '../core/interfaces/items'
import type { CoreReason, ReasonSet, Traceable } from '../core/interfaces/reasons'
import type { Tracker, TrackerContext } from '../core/interfaces/tracker'
import type { Sightings, TurnPort, TurnSpan } from '../core/interfaces/turns'

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

test('core/interfaces exports CoreReason and ReasonSet, and a plain object implements Traceable (#62)', () => {
  const all = [
    'created',
    'updated',
    'read',
    'deleted',
    'published',
    'discovered',
    'mentioned',
  ] as const satisfies readonly CoreReason[]
  const set: ReasonSet = { first: 'read', all: ['updated', 'read'], strongest: 'updated' }
  // The same names come from the item contract, for a kind author who imports one place.
  const same: ItemsCoreReason = all[0]
  const sameSet: ItemsReasonSet = set
  expect([same, sameSet.strongest]).toEqual(['created', 'updated'])

  const seen: string[] = []
  const rows: Traceable<readonly string[]> = {
    reasonsOf: (data, rowId) => {
      seen.push(rowId)
      return data?.includes(rowId) ? set : undefined
    },
  }
  expect(rows.reasonsOf(['a'], 'a')).toBe(set)
  expect(rows.reasonsOf(['a'], 'b')).toBeUndefined()
  expect(seen).toEqual(['a', 'b'])
  // A tracker with data of its own fits the intersection that the slot trackers declare.
  const tracker = {
    id: 'rows',
    order: 99,
    config: { defaults: {}, normalise: raw => raw },
    init: () => {},
    store: ctx => ctx.config.slice(),
    ...rows,
  } satisfies Tracker<JsonObject, readonly string[] & Json> & Traceable<readonly string[]>
  expect(tracker.reasonsOf(['x'], 'x')).toBe(set)
})

test('Traceable.turnsOf is optional, and TrackerContext.turn is a port with an ordinal and a note (issue #133)', () => {
  const span: TurnSpan = { first: 2, last: 5 }
  const plain: Traceable<readonly string[]> = { reasonsOf: () => undefined } // no turnsOf: a tracker as before
  const turned: Traceable<readonly string[]> = {
    reasonsOf: () => undefined,
    turnsOf: (data, rowId) => (data?.includes(rowId) ? span : undefined),
  }
  expect(plain.turnsOf).toBeUndefined()
  expect(turned.turnsOf?.(['a'], 'a')).toBe(span)
  expect(turned.turnsOf?.(['a'], 'b')).toBeUndefined()
  const noted: Sightings[] = []
  const port: TurnPort = { ord: 4, note: async s => void noted.push(s) }
  type Held = Pick<TrackerContext, 'turn'>
  const held: Held = { turn: port } // a handler of a turn's event
  const bare: Held = {} // a tick, a command, a start, a replay
  expect([held.turn?.ord, bare.turn?.ord]).toEqual([4, undefined])
})

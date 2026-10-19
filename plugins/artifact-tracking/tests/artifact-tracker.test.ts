// The artifact tracker on fakePorts, through the LifecycleManager: an Artifact tool call tracks the page or marks it
// deleted (issue #29). Each case mirrors the kit test of the same subject in artifact-wiring.test.tsx. Plan: L3 Task 12.
import { expect, test } from 'claude-code/testing'
import type { ArtifactRecord } from '../hooks/contracts'
import { artifactConfig, artifactTracker } from '../trackers/artifact'
import { DELETE, DELETE_REJECTED, PAGE_KEY, PUBLISH, READ, REFUSED } from './fixtures/artifacts'
import { managerWorld } from './fixtures/manager'

type Shape = { input: Record<string, unknown>; result: unknown }

const world = () => managerWorld({ trackers: () => [artifactTracker()] })
type World = ReturnType<typeof world>

/** One Artifact tool call. The reply is `{ result }`, or an error reply when `isError`. */
const call = (w: World, shape: Shape, isError = false) =>
  w.call('Artifact', shape.input, isError ? { isError: true, result: shape.result } : { result: shape.result })

const rows = (w: World) => w.items() as unknown as ArtifactRecord[]

test('the tracker takes order 40, hears the Artifact tool and keeps no data of its own', () => {
  const t = artifactTracker()
  expect([t.id, t.order]).toEqual(['artifact', 40])
  expect(Object.keys(t.events?.toolCall ?? {})).toEqual(['Artifact'])
  expect(t.data).toBeUndefined()
})

test('a publish tracks the page with source publish and the title of the page', async () => {
  const w = world()
  await call(w, PUBLISH)
  expect(w.keys()).toEqual([PAGE_KEY])
  expect(rows(w)[0]).toMatchObject({ category: 'artifact', label: 'Probe Page 29', sources: ['publish'] })
})

test('a delete marks the row', async () => {
  const w = world()
  await call(w, PUBLISH)
  await call(w, DELETE)
  expect(rows(w)[0]?.deleted).toBe(true)
})

test('a refused or failed call, a read and a result with no page change nothing', async () => {
  const w = world()
  await call(w, PUBLISH, true) // isError with a full publish result
  await call(w, REFUSED, true)
  await call(w, { input: REFUSED.input, result: REFUSED.result }) // a string that quotes the URL, no isError
  await call(w, READ)
  await call(w, { input: PUBLISH.input, result: { error: 'refused' } }) // no page URL
  expect(w.keys()).toEqual([])
  expect(w.w.stateSets.items).toBeUndefined()
  await call(w, PUBLISH)
  await call(w, DELETE_REJECTED, true)
  expect(rows(w)[0]?.deleted).toBeUndefined()
})

test('a delete of an unknown artifact adds no row and writes nothing', async () => {
  const w = world()
  await call(w, DELETE)
  expect(w.keys()).toEqual([])
  expect(w.w.stateSets.items).toBeUndefined()
})

test('a dismissed artifact stays out after a new publish', async () => {
  const w = world()
  await call(w, PUBLISH)
  await w.m.dismiss(w.w.ports, [PAGE_KEY])
  expect(w.keys()).toEqual([])
  await call(w, PUBLISH)
  expect(w.keys()).toEqual([])
})

test('config: enabled is a flag; a bad value falls back to the default and warns; unknown keys stay, named', () => {
  const list: string[] = []
  const warn = (p: string) => void list.push(p)
  expect(artifactConfig.defaults).toEqual({ enabled: true })
  expect(Object.isFrozen(artifactConfig.defaults)).toBe(true)
  const good = artifactConfig.normalise({ enabled: false, extra: 1 }, artifactConfig.defaults, warn)
  expect(good).toEqual({ enabled: false, extra: 1 })
  expect(list).toEqual(['extra: unknown key. The mod keeps it and ignores it.'])
  expect(artifactConfig.normalise({ enabled: 'no' }, artifactConfig.defaults, warn)).toEqual({ enabled: true })
  expect(list.slice(1)).toEqual(['enabled: "no" is not true or false. Using true.'])
})

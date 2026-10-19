// SessionWatch: the id compare, the clear/resume decision, single flight and the generation.
// Spec 5.6 (Switch). Plan: L3 Task 5, Review Focus 1.
import { expect, test } from 'claude-code/testing'
import { SessionWatch, type Switch } from '../core/infra/session'
import type { PendingEnd, Snapshot } from '../core/interfaces/slots'

/** A watch over a mutable id. `onSwitch` records every switch it is given. */
function setup(onSwitch?: (sw: Switch) => Promise<void>) {
  const box = { id: 'sess-1', switches: [] as Switch[], logs: [] as string[] }
  const watch = new SessionWatch({
    id: async () => box.id,
    onSwitch:
      onSwitch ??
      (async sw => {
        box.switches.push(sw)
      }),
    log: line => void box.logs.push(line),
  })
  return { box, watch }
}

const SNAPSHOT: Snapshot = { from: 'sess-1', slots: { items: ['a'] } }
const ended = (reason: string, fromId = 'sess-1'): PendingEnd => ({ reason, fromId, at: 1 })

test('the first check after seed reports no switch', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  expect(await watch.check()).toBe(false)
  expect(box.switches).toEqual([])
  expect(watch.lastId).toBe('sess-1')
  expect(watch.generation).toBe(0)
})

test('a check with no id seen yet learns the id and reports no switch', async () => {
  const { box, watch } = setup()
  expect(watch.lastId).toBeUndefined()
  expect(await watch.check()).toBe(false)
  expect(watch.lastId).toBe('sess-1')
  expect(box.switches).toEqual([])
})

test('a new id after ended(clear) is a clear switch with the snapshot', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  watch.ended(ended('clear'), SNAPSHOT)
  box.id = 'sess-2'
  expect(await watch.check()).toBe(true)
  expect(box.switches).toEqual([{ from: 'sess-1', to: 'sess-2', kind: 'clear', snapshot: SNAPSHOT }])
  expect(watch.lastId).toBe('sess-2')
})

test('a new id after ended(resume) is a resume switch', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  watch.ended(ended('resume'), SNAPSHOT)
  box.id = 'sess-2'
  await watch.check()
  expect(box.switches[0]).toMatchObject({ from: 'sess-1', to: 'sess-2', kind: 'resume', snapshot: SNAPSHOT })
})

test('a clear that names another id than the last seen one is a resume switch', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  watch.ended(ended('clear', 'sess-0'), { from: 'sess-0', slots: {} })
  box.id = 'sess-2'
  await watch.check()
  expect(box.switches[0]?.kind).toBe('resume')
  expect(box.switches[0]?.snapshot).toBeUndefined() // a snapshot of another session is not the one that left
})

test('a new id with no ended() is a resume switch without a snapshot', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  box.id = 'sess-2'
  await watch.check()
  expect(box.switches).toEqual([{ from: 'sess-1', to: 'sess-2', kind: 'resume', snapshot: undefined }])
})

test('two checks at once run one switch', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let calls = 0
  const { box, watch } = setup(async () => {
    calls++
    await gate
  })
  watch.seed('sess-1')
  box.id = 'sess-2'
  const first = watch.check()
  const second = watch.check()
  release()
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(calls).toBe(1)
  expect(watch.generation).toBe(1)
})

test('a check while the switch runs waits for the switch to end', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let switched = false
  const { box, watch } = setup(async () => {
    await gate
    switched = true
  })
  watch.seed('sess-1')
  box.id = 'sess-2'
  const first = watch.check()
  await Promise.resolve()
  let seenByLate: boolean | undefined
  const late = watch.check().then(() => {
    seenByLate = switched
  })
  release()
  await Promise.all([first, late])
  expect(seenByLate).toBe(true)
})

test('after a switch the next check compares again', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  box.id = 'sess-2'
  await watch.check()
  expect(await watch.check()).toBe(false)
  box.id = 'sess-3'
  expect(await watch.check()).toBe(true)
  expect(box.switches.map(s => `${s.from}>${s.to}`)).toEqual(['sess-1>sess-2', 'sess-2>sess-3'])
})

test('the pending end and the snapshot are used once', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  watch.ended(ended('clear'), SNAPSHOT)
  box.id = 'sess-2'
  await watch.check()
  box.id = 'sess-3'
  await watch.check()
  expect(box.switches[1]).toMatchObject({ from: 'sess-2', kind: 'resume', snapshot: undefined })
})

test('the generation goes up by one per switch and per bump', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  expect(watch.generation).toBe(0)
  expect(watch.bump()).toBe(1)
  box.id = 'sess-2'
  await watch.check()
  expect(watch.generation).toBe(2)
  expect(watch.bump()).toBe(3)
})

test('the generation is up before onSwitch runs', async () => {
  let seen = -1
  const box = { id: 'sess-1' }
  const watch: SessionWatch = new SessionWatch({
    id: async () => box.id,
    onSwitch: async () => {
      seen = watch.generation
    },
    log: () => {},
  })
  watch.seed('sess-1')
  box.id = 'sess-2'
  await watch.check()
  expect(seen).toBe(1)
})

test('current() runs the check first, then answers the generation', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  expect(await watch.current()).toBe(0)
  box.id = 'sess-2'
  expect(await watch.current()).toBe(1)
  expect(box.switches.length).toBe(1)
})

test('resumeFrom(pending) makes the next check switch from the pending id with no snapshot', async () => {
  const { box, watch } = setup()
  watch.seed('sess-1')
  watch.ended(ended('resume'), SNAPSHOT) // a snapshot that the reload gap would have lost
  watch.resumeFrom(ended('clear', 'sess-0'))
  expect(watch.lastId).toBe('sess-0')
  expect(await watch.check()).toBe(true)
  expect(box.switches).toEqual([{ from: 'sess-0', to: 'sess-1', kind: 'clear', snapshot: undefined }])
})

test('a failing onSwitch logs one line and keeps the new id', async () => {
  const { box, watch } = setup(async () => {
    throw new Error('boom')
  })
  watch.seed('sess-1')
  box.id = 'sess-2'
  expect(await watch.check()).toBe(true)
  expect(box.logs).toEqual(['session: switch sess-1 to sess-2 failed: boom'])
  expect(watch.lastId).toBe('sess-2')
  expect(await watch.check()).toBe(false) // no retry loop
  expect(box.logs.length).toBe(1)
})

test('a failing onSwitch that throws a non-Error is logged by its text', async () => {
  const { box, watch } = setup(async () => {
    throw 'plain'
  })
  watch.seed('sess-1')
  box.id = 'sess-2'
  await watch.check()
  expect(box.logs).toEqual(['session: switch sess-1 to sess-2 failed: plain'])
})

test('a rejected id() rejects the check and the next check can run', async () => {
  let fail = true
  const watch = new SessionWatch({
    id: async () => {
      if (fail) throw new Error('no id')
      return 'sess-1'
    },
    onSwitch: async () => {},
    log: () => {},
  })
  await expect(watch.check()).rejects.toThrow('no id')
  fail = false
  expect(await watch.check()).toBe(false)
  expect(watch.lastId).toBe('sess-1')
})

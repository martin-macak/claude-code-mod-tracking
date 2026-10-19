import { expect, test } from 'claude-code/testing'
import { RepoQueue } from '../trackers/repos/queue'

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('RepoQueue runs one job at a time', async () => {
  const q = new RepoQueue()
  let inFlight = 0
  let peak = 0
  const job = (): Promise<void> =>
    (async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight--
    })()
  for (let i = 0; i < 5; i++) expect(q.push('k' + i, job)).toBe(true)
  await q.idle()
  expect(peak).toBe(1)
})

test('RepoQueue drops a job and returns false when max jobs wait', async () => {
  const q = new RepoQueue(2)
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const ran: string[] = []
  const hold = async () => {
    await held
    ran.push('hold')
  }
  expect(q.push('a', hold)).toBe(true) // starts at once: it no longer waits
  await sleep(0)
  expect(q.push('b', async () => void ran.push('b'))).toBe(true)
  expect(q.push('c', async () => void ran.push('c'))).toBe(true)
  expect(q.push('d', async () => void ran.push('d'))).toBe(false)
  release()
  await q.idle()
  expect(ran).toEqual(['hold', 'b', 'c'])
})

test('RepoQueue does not add a key that already waits, but accepts it again once it runs', async () => {
  const q = new RepoQueue()
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const ran: string[] = []
  q.push('first', async () => {
    await held
    ran.push('first')
  })
  await sleep(0)
  expect(q.push('same', async () => void ran.push('same-1'))).toBe(true)
  expect(q.push('same', async () => void ran.push('same-2'))).toBe(true) // deduped: reported as taken care of
  release()
  await q.idle()
  expect(ran).toEqual(['first', 'same-1'])
  q.push('same', async () => void ran.push('same-3'))
  await q.idle()
  expect(ran).toEqual(['first', 'same-1', 'same-3'])
})

test('RepoQueue goes on after a job that throws or rejects', async () => {
  const q = new RepoQueue()
  const ran: string[] = []
  q.push('a', () => {
    throw new Error('sync')
  })
  q.push('b', () => Promise.reject(new Error('async')))
  q.push('c', async () => void ran.push('c'))
  await q.idle()
  expect(ran).toEqual(['c'])
})

test('RepoQueue.idle resolves after the last job, and at once when empty', async () => {
  const q = new RepoQueue()
  await q.idle()
  let done = false
  q.push('a', async () => {
    await sleep(10)
    done = true
  })
  await q.idle()
  expect(done).toBe(true)
})

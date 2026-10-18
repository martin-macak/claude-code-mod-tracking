// The refresh lanes the item runtime builds from the kinds: which categories have one, and what a manual refresh resets.
// The coordinator itself is tested in coordinator.test.ts. Plan: L5 Task 7.
import { expect, test } from 'claude-code/testing'
import { itemsWorld, promptRow, res } from './fixtures/items'

test('a manual refresh resets the tool class of each lane, not only its handle', async () => {
  const t = itemsWorld({
    run: argv => (argv[1] === 'auth' && argv.includes('ghe.corp') ? res('', 1, 'not logged in') : undefined),
  })
  const rt = await t.started()
  const gh = rt.autoGithub.discovery
  expect(await gh.checkHost('ghe.corp')).toBe(false)
  expect(gh.isHostAuthed('ghe.corp')).toBe(false) // the denial is cached
  rt.kick('manual')
  expect(gh.isHostAuthed('ghe.corp')).toBeUndefined() // the lane called GhTool.reset, which forgets denied hosts
})

test('only the kinds with a refresh spec have a lane: a web link makes no call, an issue does', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://docs.example/a and https://github.com/acme/web/issues/9'))
  expect(t.keys().sort()).toEqual(['gh:github.com/acme/web#9', 'web:https://docs.example/a'])
  await rt.refreshAll()
  const record = t.list().find(r => r.key === 'gh:github.com/acme/web#9') as { title?: string }
  expect(record.title).toBe('Web nine') // the github lane filled the status
  expect(t.list().find(r => r.category === 'web')).not.toHaveProperty('refreshedAt') // the web link has no lane
})

test('a stored record of a malformed shape is never due and does not stop the run for the others', async () => {
  const t = itemsWorld()
  const bad = {
    key: 'gh:github.com/acme/web#7',
    category: 'github', // no number: the kind does not decode it
    url: 'https://github.com/acme/web/issues/7',
    label: '#7',
    sources: ['prompt'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  t.w.state.set('items', [bad] as never)
  const rt = await t.started()
  await rt.capture(promptRow('see https://github.com/acme/web/issues/9'))
  await rt.refreshAll()
  const list = t.list() as unknown as { key: string; title?: string; refreshedAt?: number }[]
  expect(list.find(r => r.key === 'gh:github.com/acme/web#9')?.title).toBe('Web nine') // the good record refreshed
  expect(list.find(r => r.key === bad.key)).toEqual(bad) // the bad one is left as it was
})

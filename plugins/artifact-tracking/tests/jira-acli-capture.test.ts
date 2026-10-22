// The Jira items that a Bash `acli jira workitem` call names, through the item service on fakePorts.
// acli answers `Site: acme.atlassian.net`. Spec: docs/superpowers/specs/2026-10-21-jira-acli-capture-design.md.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import { viewGroups } from '../core/lib/grouping'
import { fakeItems, promptRow, replayTool, res, until } from './fixtures/items'
import { turnWorld } from './fixtures/turn-world'

const KEY = 'jira:acme.atlassian.net/TEAL-2071'
const OTHER = 'jira:acme.atlassian.net/TEAL-2072'

/** The calls of `acli jira auth status` that a fake world saw. */
const lookups = (calls: readonly string[][]) => calls.filter(c => c[0] === 'acli' && c[2] === 'auth').length

const bash = (command: string, result: Json = { stdout: 'ok' }) => ({
  tool: 'Bash',
  input: { command },
  result,
})

test('acli view tracks the key on the active site, with the reason read', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(t.keys()).toEqual([KEY])
  expect(t.list()[0]?.sources).toEqual(['tool'])
  expect(t.list()[0]?.reasons.all).toEqual(['read'])
})

test('acli transition tracks the key, with the reason updated', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem transition --key TEAL-2071 --status Done'))
  expect(t.keys()).toEqual([KEY])
  expect(t.list()[0]?.reasons.all).toEqual(['updated'])
})

test('each acli command that changes the item claims updated, and clone claims mentioned', async () => {
  const claimed = async (command: string) => {
    const t = fakeItems()
    const items = await t.started()
    await items.toolCall(bash(command))
    return t.list()[0]?.reasons.all
  }
  expect(await claimed('acli jira workitem edit --key TEAL-2071 --summary x')).toEqual(['updated'])
  expect(await claimed('acli jira workitem assign --key TEAL-2071 --assignee @me')).toEqual(['updated'])
  expect(await claimed('acli jira workitem comment create --key TEAL-2071 --body hi')).toEqual(['updated'])
  expect(await claimed('acli jira workitem archive --key TEAL-2071')).toEqual(['updated'])
  expect(await claimed('acli jira workitem unarchive --key TEAL-2071')).toEqual(['updated'])
  expect(await claimed('acli jira workitem comment list --key TEAL-2071')).toEqual(['read'])
  expect(await claimed('acli jira workitem clone --key TEAL-2071')).toEqual(['mentioned'])
})

test('acli search tracks nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem search --jql "assignee = currentUser()"'))
  expect(t.keys()).toEqual([])
})

test('a chained command tracks the key once', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('cd x && acli jira workitem view TEAL-2071 | head'))
  expect(t.keys()).toEqual([KEY])
})

test('a call the tool reported as an error tracks nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-2071', { isError: true, text: 'does not exist' }))
  expect(t.keys()).toEqual([])
})

test('a denied call tracks nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-2071', { deny: 'not allowed' }))
  expect(t.keys()).toEqual([])
})

test('with acli logged out nothing is tracked', async () => {
  const t = fakeItems({
    run: async argv => (argv[0] === 'acli' && argv[2] === 'auth' ? res('', 1, 'unauthorized: log in') : undefined),
  })
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(t.keys()).toEqual([])
})

test('a key already tracked from its URL stays one item with both channels', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://acme.atlassian.net/browse/TEAL-2071'))
  await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(t.keys()).toEqual([KEY])
  expect(t.list()[0]?.sources).toEqual(['prompt', 'tool'])
})

test('a word that is no key tracks nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view utf-8'))
  await items.toolCall(bash('acli jira workitem transition --key "A-1,B-2" --status Done'))
  expect(t.keys()).toEqual([])
})

test('the jira tracker off: nothing is tracked', async () => {
  const t = fakeItems({ off: ['jira'] })
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(t.keys()).toEqual([])
})

test('a reserved word or a wrapper in front of acli does not hide the call', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('if ! acli jira workitem view TEAL-2071; then echo missing; fi'))
  expect(t.keys()).toEqual([KEY])
})

test('a replayed acli use tracks the key; a replayed use that failed does not', async () => {
  const t = fakeItems()
  const items = await t.started()
  const use = (isError: boolean) =>
    replayTool('Bash', { command: 'acli jira workitem view TEAL-2071' }, { tool: 'Bash', isError })
  await items.replay([use(true)])
  expect(t.keys()).toEqual([])
  await items.replay([use(false)])
  expect(t.keys()).toEqual([KEY])
})

test('with acli not installed nothing is tracked', async () => {
  const t = fakeItems({ run: async argv => (argv[0] === 'acli' ? res('', 127, 'acli: command not found') : undefined) })
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(t.keys()).toEqual([])
})

// The accepted wait (review of #150, m1): the first acli call of a session waits for `acli jira auth status` under the tool
// hook, as a Jira URL in a tool result does (`accept`). A load does not warm the site: a new session with acli installed
// makes no lookup (tests/toggles.test.ts). The wait is bounded and shared by the calls that ask at once. A site, or a "not
// logged in" answer, is cached. A lookup that fails for another reason is asked again by the next acli call, until the
// breaker opens. A Bash call that names no acli item never waits for the lookup.
test('the first acli call waits for one shared site lookup; another Bash call does not wait for it', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const t = fakeItems({
    run: async argv => {
      if (argv[0] === 'acli' && argv[2] === 'auth') await held // the lookup stays open until the test lets it go
      return undefined
    },
  })
  const items = await t.started()
  expect(lookups(t.world.calls)).toBe(0)
  const first = items.toolCall(bash('acli jira workitem view TEAL-2071'))
  const second = items.toolCall(bash('acli jira workitem view TEAL-2072'))
  await until(() => lookups(t.world.calls) === 1, 'the site lookup')
  await items.toolCall(bash('echo hello')) // answers while the lookup is held
  expect(t.keys()).toEqual([])
  release()
  await Promise.all([first, second])
  expect([...t.keys()].sort()).toEqual([KEY, OTHER])
  await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(lookups(t.world.calls)).toBe(1) // two calls shared one lookup, and a third finds the site cached
})

test('a replayed acli use waits for the one shared site lookup and no more', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.replay([
    replayTool('Bash', { command: 'acli jira workitem view TEAL-2071' }, { tool: 'Bash', isError: false }),
    replayTool('Bash', { command: 'acli jira workitem view TEAL-2072' }, { tool: 'Bash', isError: false }),
  ])
  expect(t.keys()).toEqual([KEY, OTHER])
  expect(lookups(t.world.calls)).toBe(1)
})

test('a site lookup that fails without "unauthorized" is asked again by the next acli call, until the breaker opens', async () => {
  const t = fakeItems({
    run: async argv => (argv[0] === 'acli' && argv[2] === 'auth' ? res('', 1, 'dial tcp: i/o timeout') : undefined),
  })
  const items = await t.started()
  for (let i = 0; i < 5; i++) await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(t.keys()).toEqual([])
  expect(lookups(t.world.calls)).toBe(3) // the breaker opens after 3 failures; then an acli call waits for no lookup
})

test('a "not logged in" answer is cached: the next acli calls ask no more', async () => {
  const t = fakeItems({
    run: async argv => (argv[0] === 'acli' && argv[2] === 'auth' ? res('', 1, 'unauthorized: log in') : undefined),
  })
  const items = await t.started()
  for (let i = 0; i < 5; i++) await items.toolCall(bash('acli jira workitem view TEAL-2071'))
  expect(t.keys()).toEqual([])
  expect(lookups(t.world.calls)).toBe(1)
})

// Issue #133: the capture funnel stamps an item with the turn of the event, so a tool call of a turn lands in its ledger
// entry with its strongest reason, and the pane row says from which turn to which turn it was tracked.
test('an acli call of a turn lands in the turn ledger; the row has its turns, reasons and facets', async () => {
  const t = turnWorld()
  await t.start('turn-1', 'move the ticket')
  await t.bash('acli jira workitem transition --key TEAL-2071 --status Done')
  await t.end('turn-1')
  expect(t.rec(1).new).toEqual([{ k: KEY, c: 'jira', r: 'updated' }])
  await t.start('turn-2', 'what is its state')
  await t.bash('acli jira workitem view TEAL-2071')
  await t.end('turn-2')
  expect(t.rec(2).new).toEqual([])
  expect(t.rec(2).seen).toEqual([{ k: KEY, c: 'jira', r: 'read' }])
  await t.rt.refreshAll() // acli answers its view with a status in the category `new`
  const row = (await t.rows()).find(r => r.id === KEY)
  expect(row?.turns).toEqual({ first: 1, last: 2 })
  expect(row?.reasons?.all).toEqual(['updated', 'read'])
  expect(row?.facets?.status?.token).toBe('waiting')
  expect(row?.facets?.firstSeen).toBe(t.items().find(r => r.key === KEY)?.firstSeen)
})

// Issue #63: the `t` key hides the rows that were only discovered or mentioned. An item that acli changed is touched.
test('the touched-only filter keeps an item that acli changed and hides one that acli only cloned', async () => {
  const t = turnWorld()
  await t.start('turn-1', 'work the board')
  await t.bash('acli jira workitem transition --key TEAL-2071 --status Done')
  await t.bash('acli jira workitem clone --key TEAL-2072')
  await t.end('turn-1')
  const sections = await t.m.paneData(t.w.ports, { selected: null, expanded: new Set() })
  const all = viewGroups(sections, 'flat', { touchedOnly: false }).groups.flatMap(g => g.rows.map(r => r.id))
  expect(all).toEqual([KEY, OTHER])
  const touched = viewGroups(sections, 'flat', { touchedOnly: true })
  expect(touched.groups.flatMap(g => g.rows.map(r => r.id))).toEqual([KEY])
  expect(touched.hidden).toBe(1)
  const byReason = viewGroups(sections, 'reason', { touchedOnly: false }).groups
  expect(byReason.map(g => [g.title, g.rows.map(r => r.id)])).toEqual([
    ['Updated', [KEY]],
    ['Mentioned', [OTHER]],
  ])
})

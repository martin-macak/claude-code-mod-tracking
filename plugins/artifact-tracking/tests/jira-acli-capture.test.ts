// The Jira items that a Bash `acli jira workitem` call names, through the item service on fakePorts.
// acli answers `Site: acme.atlassian.net`. Spec: docs/superpowers/specs/2026-10-21-jira-acli-capture-design.md.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import { viewGroups } from '../core/lib/grouping'
import { fakeItems, promptRow, replayTool, res, toolResultRow, until } from './fixtures/items'
import { reasonsOfSources } from './fixtures/reasons'
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

// Issue #225: the active site is read again after an `acli jira auth` or `acli auth` login, logout or switch in a Bash call,
// and on `/track refresh`. A key that is already tracked keeps its site. The fake acli reads its site when a call runs.
const ACME = 'acme.atlassian.net'
const BETA = 'beta.atlassian.net'
const ON_ACME = `jira:${ACME}/TEAL-1`

/** A fake acli whose active site is `w.site`. It reads the site when a call runs, as acli reads its profile. */
const acliAt = (w: { site: string }) => async (argv: string[]) =>
  argv[0] === 'acli' && argv[2] === 'auth'
    ? res(`\u2713 Authenticated\n  Site: ${w.site}\n  Email: <email>\n`)
    : undefined

function switching() {
  const w = { site: ACME }
  return { t: fakeItems({ run: acliAt(w) }), w }
}

test('after an acli jira auth switch the next key is filed under the new site; a key filed before keeps its site', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash(`acli jira auth switch --site ${BETA}`))
  await items.toolCall(bash('acli jira workitem view TEAL-2'))
  expect(t.keys()).toEqual([ON_ACME, `jira:${BETA}/TEAL-2`])
  expect(lookups(t.world.calls)).toBe(2)
})

test('with no auth command in the session a site that changed on its own is not seen: the documented limit', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA // a switch in another terminal
  await items.toolCall(bash('acli jira workitem view TEAL-2'))
  expect(t.keys()).toEqual([ON_ACME, `jira:${ACME}/TEAL-2`])
})

test('each login, logout and switch of acli jira auth and acli auth makes the next key read the site again', async () => {
  for (const command of [
    'acli jira auth login --web',
    'acli jira auth logout',
    'acli auth switch',
    'acli auth login',
    'acli auth logout',
  ]) {
    const { t, w } = switching()
    const items = await t.started()
    await items.toolCall(bash('acli jira workitem view TEAL-1'))
    w.site = BETA
    await items.toolCall(bash(command))
    await items.toolCall(bash('acli jira workitem view TEAL-2'))
    expect([command, t.keys()]).toEqual([command, [ON_ACME, `jira:${BETA}/TEAL-2`]])
  }
})

test('a switch and a key in one command: the key takes the site that is read after the switch', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash(`acli jira auth switch --site ${BETA} && acli jira workitem view TEAL-2`))
  expect(t.keys()).toEqual([ON_ACME, `jira:${BETA}/TEAL-2`])
})

// The documented limit (1) of the README: the reader keeps no order between the key and the switch of one command, so a key
// named before the switch takes the site that is read after it. If the reader learns the order, this test flips.
test('a key and then a switch in one command: the key takes the site that is read after the switch (documented limit)', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash(`acli jira workitem view TEAL-2 && acli jira auth switch --site ${BETA}`))
  expect(t.keys()).toEqual([ON_ACME, `jira:${BETA}/TEAL-2`])
})

test('a denied switch changes nothing: the next key keeps the cached site', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash(`acli jira auth switch --site ${BETA}`, { deny: 'not allowed' }))
  await items.toolCall(bash('acli jira workitem view TEAL-2'))
  expect(t.keys()).toEqual([ON_ACME, `jira:${ACME}/TEAL-2`])
})

test('a switch the tool reported as an error forgets the site and adds no claim', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash(`acli jira auth switch --site ${BETA}; false`, { isError: true, text: 'exit 1' }))
  expect(t.keys()).toEqual([ON_ACME]) // the failed command adds no claim
  await items.toolCall(bash('acli jira workitem view TEAL-2'))
  expect(t.keys()).toEqual([ON_ACME, `jira:${BETA}/TEAL-2`])
})

test('acli jira auth status changes nothing, so the next key keeps the cached site', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash('acli jira auth status'))
  await items.toolCall(bash('acli jira workitem view TEAL-2'))
  expect(t.keys()).toEqual([ON_ACME, `jira:${ACME}/TEAL-2`])
  expect(lookups(t.world.calls)).toBe(1)
})

test('/track refresh reads the site again when a Jira item exists; the next key takes the new site', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  expect(lookups(t.world.calls)).toBe(1)
  w.site = BETA // a switch that the mod did not see
  await items.refreshAll()
  expect(lookups(t.world.calls)).toBe(2)
  await items.toolCall(bash('acli jira workitem view TEAL-2'))
  expect(t.keys()).toEqual([ON_ACME, `jira:${BETA}/TEAL-2`])
  expect(lookups(t.world.calls)).toBe(2)
})

test('/track refresh with no Jira item makes no site lookup', async () => {
  const { t } = switching()
  const items = await t.started()
  await items.refreshAll()
  expect(lookups(t.world.calls)).toBe(0)
})

test('after the switch and a refresh the old key keeps its site, is not asked again, and its row reads track-only', async () => {
  const w = { site: ACME }
  const t = turnWorld({ run: acliAt(w) })
  await t.bash('acli jira workitem view TEAL-1')
  w.site = BETA
  await t.bash(`acli jira auth switch --site ${BETA}`)
  await t.bash('acli jira workitem view TEAL-2')
  const before = t.w.calls.length
  await t.rt.refreshAll()
  const viewed = t.w.calls.slice(before).filter(c => c[0] === 'acli' && c[3] === 'view')
  expect(viewed.map(c => c[4])).toEqual(['TEAL-2']) // TEAL-1 is on acme: acli cannot ask for it on beta
  expect(t.items().find(r => r.key === ON_ACME)).toMatchObject({ site: ACME })
  expect((await t.rows()).find(r => r.id === ON_ACME)?.cells.status).toEqual({ text: 'track-only' })
})

test('after the switch a Jira URL of the new site in a tool result is accepted, and one of the old site is not', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash(`acli jira auth switch --site ${BETA}`))
  await items.capture(toolResultRow(`see https://${BETA}/browse/NEW-1 and https://${ACME}/browse/OLD-9`))
  expect(t.keys()).toEqual([ON_ACME, `jira:${BETA}/NEW-1`])
})

test('a site lookup that fails after a switch files no key; the next acli call asks again', async () => {
  let mode: 'ok' | 'fail' = 'ok'
  const t = fakeItems({
    run: async argv =>
      argv[0] === 'acli' && argv[2] === 'auth'
        ? mode === 'ok'
          ? res('\u2713 Authenticated\n  Site: acme.atlassian.net\n')
          : res('', 1, 'dial tcp: i/o timeout')
        : undefined,
  })
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  mode = 'fail'
  await items.toolCall(bash('acli jira auth switch --site beta.atlassian.net'))
  await items.toolCall(bash('acli jira workitem view TEAL-2'))
  expect(t.keys()).toEqual([ON_ACME]) // a missing row, not one under a wrong site
  const asked = lookups(t.world.calls)
  mode = 'ok'
  await items.toolCall(bash('acli jira workitem view TEAL-3'))
  expect(lookups(t.world.calls)).toBe(asked + 1)
  expect(t.keys()).toEqual([ON_ACME, `jira:${ACME}/TEAL-3`])
})

test('a replayed acli auth command forgets the site like a live one: a later key reads it again', async () => {
  const { t, w } = switching()
  const items = await t.started()
  const use = (command: string) => replayTool('Bash', { command }, { tool: 'Bash', isError: false })
  await items.replay([use('acli jira workitem view TEAL-1')])
  w.site = BETA
  await items.replay([use('acli jira auth switch'), use('acli jira workitem view TEAL-2')])
  expect(t.keys()).toEqual([ON_ACME, `jira:${BETA}/TEAL-2`])
  expect(lookups(t.world.calls)).toBe(2)
})

// Owner decision Q1 of #225: a load keeps its rule. After a switch, a stored row that only a tool call named is dropped when
// its site is not the active one. A row that a prompt named stays.
test('after the switch a load drops a stored old-site row that only a tool call named, and keeps one a prompt named', async () => {
  const { t, w } = switching()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem view TEAL-1'))
  w.site = BETA
  await items.toolCall(bash(`acli jira auth switch --site ${BETA}`))
  const stored = (key: string, sources: string[]) => ({
    key: `jira:${ACME}/${key}`,
    category: 'jira',
    url: `https://${ACME}/browse/${key}`,
    label: key,
    sources,
    reasons: reasonsOfSources(sources),
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
    site: ACME,
    issueKey: key,
    trackOnly: false,
    children: [],
  })
  await items.slot.restore([stored('TEAL-9', ['tool']), stored('TEAL-8', ['prompt'])] as unknown as Json, 'load')
  expect(t.keys().sort()).toEqual([ON_ACME, `jira:${ACME}/TEAL-8`])
})

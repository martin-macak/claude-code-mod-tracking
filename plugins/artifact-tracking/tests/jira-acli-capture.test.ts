// The Jira items that a Bash `acli jira workitem` call names, through the item service on fakePorts.
// acli answers `Site: acme.atlassian.net`. Spec: docs/superpowers/specs/2026-10-21-jira-acli-capture-design.md.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import { fakeItems, promptRow, res } from './fixtures/items'

const KEY = 'jira:acme.atlassian.net/TEAL-2071'

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

test('acli transition tracks the key, with the reason mentioned', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.toolCall(bash('acli jira workitem transition --key TEAL-2071 --status Done'))
  expect(t.keys()).toEqual([KEY])
  expect(t.list()[0]?.reasons.all).toEqual(['mentioned'])
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

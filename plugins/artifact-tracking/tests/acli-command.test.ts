// The Jira work items that a Bash command names through `acli jira workitem <sub>`. Pure.
import { expect, test } from 'claude-code/testing'
import { acliWorkitems } from '../trackers/jira/acli-command'

const read = (key: string) => ({ key, read: true })
const write = (key: string) => ({ key, read: false })

test('view takes the key as its first argument, and it is a read', () => {
  expect(acliWorkitems('acli jira workitem view TEAL-2071')).toEqual([read('TEAL-2071')])
})

test('view with flags before or after the key still finds the key', () => {
  expect(acliWorkitems('acli jira workitem view TEAL-2071 --fields summary,comment --json')).toEqual([
    read('TEAL-2071'),
  ])
  expect(acliWorkitems('acli jira workitem view --json TEAL-2071')).toEqual([read('TEAL-2071')])
})

test('quotes are dropped; a key must be typed in upper case, as Jira writes it', () => {
  expect(acliWorkitems('acli jira workitem view "TEAL-2071"')).toEqual([read('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem view teal-2071')).toEqual([])
})

test('comment list is a read; the other comment forms are writes', () => {
  expect(acliWorkitems('acli jira workitem comment list --key TEAL-2071')).toEqual([read('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem comment create --key TEAL-2071 --body "hi"')).toEqual([write('TEAL-2071')])
})

test('a write sub-command takes the key from --key, --key= or -k', () => {
  expect(acliWorkitems('acli jira workitem transition --key TEAL-2071 --status Done')).toEqual([write('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem edit --key=TEAL-2071 --summary x')).toEqual([write('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem assign -k TEAL-2071 --assignee @me')).toEqual([write('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem clone --key "TEAL-2071"')).toEqual([write('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem archive --key TEAL-2071')).toEqual([write('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem unarchive --key TEAL-2071')).toEqual([write('TEAL-2071')])
})

test('search, create, delete and link name no tracked item', () => {
  expect(acliWorkitems('acli jira workitem search --jql "assignee = currentUser()"')).toEqual([])
  expect(acliWorkitems('acli jira workitem create --project TEAL --summary x')).toEqual([])
  expect(acliWorkitems('acli jira workitem delete --key TEAL-2071')).toEqual([])
  expect(acliWorkitems('acli jira workitem link create --out TEAL-1 --in TEAL-2 --type Blocks')).toEqual([])
})

test('a list of keys names no single item', () => {
  expect(acliWorkitems('acli jira workitem transition --key "A-1,B-2" --status Done')).toEqual([])
})

test('a word that is no key adds nothing', () => {
  expect(acliWorkitems('acli jira workitem view utf-8')).toEqual([])
  expect(acliWorkitems('acli jira workitem view')).toEqual([])
  expect(acliWorkitems('acli jira workitem edit --summary TEAL-2071')).toEqual([])
})

test('a command that is not acli jira workitem adds nothing', () => {
  expect(acliWorkitems('echo acli jira workitem view TEAL-2071')).toEqual([])
  expect(acliWorkitems('acli jira project view TEAL')).toEqual([])
  expect(acliWorkitems('gh issue view 5')).toEqual([])
})

test('a chain: each acli command counts, in order; the store merges a repeated key', () => {
  expect(acliWorkitems('cd x && acli jira workitem view ABC-1 | head')).toEqual([read('ABC-1')])
  expect(
    acliWorkitems('acli jira workitem view ABC-1; acli jira workitem transition --key ABC-1 --status Done'),
  ).toEqual([read('ABC-1'), write('ABC-1')])
})

test('the acli binary may carry a path', () => {
  expect(acliWorkitems('/opt/homebrew/bin/acli jira workitem view TEAL-2071')).toEqual([read('TEAL-2071')])
})

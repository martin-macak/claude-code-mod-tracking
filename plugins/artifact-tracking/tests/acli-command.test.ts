// The Jira work items that a Bash command names through `acli jira workitem <sub>`. Pure.
import { expect, test } from 'claude-code/testing'
import { acliAuthChange, acliWorkitems } from '../trackers/jira/acli-command'

const read = (key: string) => ({ key, reason: 'read' })
const updated = (key: string) => ({ key, reason: 'updated' })
const mentioned = (key: string) => ({ key, reason: 'mentioned' })

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

test('comment list is a read; the other comment forms change the item', () => {
  expect(acliWorkitems('acli jira workitem comment list --key TEAL-2071')).toEqual([read('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem comment create --key TEAL-2071 --body "hi"')).toEqual([updated('TEAL-2071')])
})

test('a sub-command that changes the item takes the key from --key, --key= or -k, with the reason updated', () => {
  expect(acliWorkitems('acli jira workitem transition --key TEAL-2071 --status Done')).toEqual([updated('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem edit --key=TEAL-2071 --summary x')).toEqual([updated('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem assign -k TEAL-2071 --assignee @me')).toEqual([updated('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem archive --key TEAL-2071')).toEqual([updated('TEAL-2071')])
  expect(acliWorkitems('acli jira workitem unarchive --key TEAL-2071')).toEqual([updated('TEAL-2071')])
})

test('clone changes no source item: it is only mentioned', () => {
  expect(acliWorkitems('acli jira workitem clone --key "TEAL-2071"')).toEqual([mentioned('TEAL-2071')])
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

// acli reads `--key` as one string flag: a repeated flag keeps its last value, so two different values name no single
// item. The attached short forms `-kKEY` and `-k=KEY` are the same flag.
test('two different --key values name no single item; the attached -k forms count', () => {
  expect(acliWorkitems('acli jira workitem edit --key ABC-1 --key ABC-2 --summary x')).toEqual([])
  expect(acliWorkitems('acli jira workitem edit --key=ABC-1 -k ABC-2 --summary x')).toEqual([])
  expect(acliWorkitems('acli jira workitem edit -k ABC-1 -k ABC-1')).toEqual([updated('ABC-1')])
  expect(acliWorkitems('acli jira workitem assign -kABC-1 --assignee @me')).toEqual([updated('ABC-1')])
  expect(acliWorkitems('acli jira workitem assign -k=ABC-1 --assignee @me')).toEqual([updated('ABC-1')])
})

test('a word that starts with -k is text, not a second key: only a key glued to -k counts', () => {
  expect(acliWorkitems('acli jira workitem comment create --key ABC-1 --body "-kind words"')).toEqual([
    updated('ABC-1'),
  ])
  expect(acliWorkitems('acli jira workitem comment create -kABC-1 --body "-kind words"')).toEqual([updated('ABC-1')])
})

test('view names one item: two keys add nothing, and the same key twice is one', () => {
  expect(acliWorkitems('acli jira workitem view AB-1 CD-2')).toEqual([])
  expect(acliWorkitems('acli jira workitem view --fields ABC-9 DEF-2')).toEqual([])
  expect(acliWorkitems('acli jira workitem view AB-1 AB-1')).toEqual([read('AB-1')])
})

test('a word that is no key adds nothing', () => {
  expect(acliWorkitems('acli jira workitem view utf-8')).toEqual([])
  expect(acliWorkitems('acli jira workitem view')).toEqual([])
  expect(acliWorkitems('acli jira workitem edit --summary TEAL-2071')).toEqual([])
  expect(acliWorkitems('acli jira workitem edit --summary x --key')).toEqual([]) // a flag with no value
})

test('a command that is not acli jira workitem adds nothing', () => {
  expect(acliWorkitems('echo acli jira workitem view TEAL-2071')).toEqual([])
  expect(acliWorkitems('acli jira project view TEAL')).toEqual([])
  expect(acliWorkitems('gh issue view 5')).toEqual([])
})

test('a missing or an unknown sub-command adds nothing, whatever its name', () => {
  expect(acliWorkitems('acli jira workitem')).toEqual([])
  expect(acliWorkitems('acli jira workitem --key TEAL-2071')).toEqual([])
  expect(acliWorkitems('acli jira workitem constructor --key TEAL-2071')).toEqual([])
  expect(acliWorkitems('acli jira workitem toString --key TEAL-2071')).toEqual([])
})

test('a chain: each acli command counts, in order; the store merges a repeated key', () => {
  expect(acliWorkitems('cd x && acli jira workitem view ABC-1 | head')).toEqual([read('ABC-1')])
  expect(
    acliWorkitems('acli jira workitem view ABC-1; acli jira workitem transition --key ABC-1 --status Done'),
  ).toEqual([read('ABC-1'), updated('ABC-1')])
})

test('the acli binary may carry a path', () => {
  expect(acliWorkitems('/opt/homebrew/bin/acli jira workitem view TEAL-2071')).toEqual([read('TEAL-2071')])
})

test('a reserved word, a wrapper or an env prefix in front of acli does not hide it', () => {
  expect(acliWorkitems('if ! acli jira workitem view ABC-1; then echo no; fi')).toEqual([read('ABC-1')])
  expect(acliWorkitems('if acli jira workitem view ABC-1; then echo ok; fi')).toEqual([read('ABC-1')])
  expect(acliWorkitems('if true; then acli jira workitem view ABC-1; fi')).toEqual([read('ABC-1')])
  expect(acliWorkitems('while true; do acli jira workitem view ABC-1; done')).toEqual([read('ABC-1')])
  expect(acliWorkitems('! acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('time acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('time -p acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('time -- acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('time -p ! acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('sudo acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('env X=1 acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('command acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('nohup acli jira workitem view ABC-1 &')).toEqual([read('ABC-1')])
  expect(acliWorkitems('FOO=1 acli jira workitem transition --key ABC-1 --status Done')).toEqual([updated('ABC-1')])
})

// Bash gives `time` only `-p`, then `--`. After them the next word is the command: `time -x acli ...` runs a command
// named `-x`, so `acli` runs nothing.
test('time with an option other than -p or -- in front of acli names no item', () => {
  expect(acliWorkitems('time -x acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time -p -p acli jira workitem view ABC-1')).toEqual([])
})

// Bash reads an option of `time` only when it was typed whole. `time "-p" acli ...` runs a command named `-p`, so `acli`
// runs nothing (Codex review of the PR).
test('a quoted or escaped option of time in front of acli names no item', () => {
  expect(acliWorkitems('time "-p" acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems("time '-p' acli jira workitem view ABC-1")).toEqual([])
  expect(acliWorkitems('time \\-p acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time -"p" acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time "--" acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time -p "--" acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time -p \\-- acli jira workitem view ABC-1')).toEqual([])
  // The controls: the same options typed whole are still skipped.
  expect(acliWorkitems('time -p -- acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
})

// A redirection between `time` and an option ends the options: `time >/dev/null -p acli ...` runs a command named `-p`
// (bash 3.2 and 5.3), so `acli` runs nothing. `splitShell` drops the redirection, and the reader must still see it.
test('a redirection between time and its option makes the option the command, so acli names no item', () => {
  expect(acliWorkitems('time >/dev/null -p acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time > /dev/null -p acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time 2>&1 -p acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time </dev/null -- acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time -p >/dev/null -- acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time -p 2>&1 -- acli jira workitem view ABC-1')).toEqual([])
  expect(acliWorkitems('time <<EOF -p acli jira workitem view ABC-1\nbody\nEOF')).toEqual([])
  expect(acliWorkitems('time -p <<EOF -- acli jira workitem view ABC-1\nbody\nEOF')).toEqual([])
  expect(acliWorkitems('if ! time >/dev/null -p acli jira workitem view ABC-1; then :; fi')).toEqual([])
  // The controls: a redirection behind the options, in front of acli, is no matter.
  expect(acliWorkitems('time -p >/dev/null acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('time -p -- >/dev/null acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('time >/dev/null acli jira workitem view ABC-1')).toEqual([read('ABC-1')])
  expect(acliWorkitems('time -p acli jira workitem view ABC-1 >/dev/null')).toEqual([read('ABC-1')])
})

// `command -v acli` only looks the program up. The options of `command` stay in front of `acli`, so it is no call.
test('command -v in front of acli runs nothing, so it names no item', () => {
  expect(acliWorkitems('command -v acli jira workitem view ABC-1')).toEqual([])
})

test('a quoted reserved word is a command of its own, so it is no lead word', () => {
  expect(acliWorkitems("'if' acli jira workitem view ABC-1")).toEqual([])
})

// Issue #225: a command that logs in, logs out or switches the acli account may change the active site.
test('acliAuthChange: login, logout and switch of both acli families count', () => {
  for (const command of [
    'acli jira auth switch --site b.atlassian.net',
    'acli jira auth login --web',
    'acli jira auth logout',
    'acli auth switch',
    'acli auth login',
    'acli auth logout',
  ])
    expect([command, acliAuthChange(command)]).toEqual([command, true])
})

test('acliAuthChange: a path, a chain and a wrapper in front of acli do not hide it', () => {
  for (const command of [
    '/opt/homebrew/bin/acli jira auth switch',
    'cd x && acli jira auth switch',
    'sudo acli jira auth switch',
    'FOO=1 acli jira auth switch',
    'if true; then acli jira auth switch; fi',
    'acli jira auth switch --site b.atlassian.net && acli jira workitem view TEAL-2',
  ])
    expect([command, acliAuthChange(command)]).toEqual([command, true])
})

test('acliAuthChange: status, other sub-commands, other families and plain text do not count', () => {
  for (const command of [
    'acli jira auth status',
    'acli jira auth',
    'acli auth status',
    'acli jira workitem view ABC-1',
    'echo acli jira auth switch',
    'gh auth switch',
    'acli admin auth switch',
    'acli rovodev auth login',
    'acli jira workitem comment create --key A-1 --body "acli jira auth switch"',
    // Documented limit (README, Known limits): the shell reader does not open `bash -c`. If it learns to, flip these two.
    'bash -c "acli jira auth switch"',
    'sh -c "acli jira auth switch"',
    '',
  ])
    expect([command, acliAuthChange(command)]).toEqual([command, false])
})

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { answer, FAKE_ACLI_CALLS, type FakeAcliSpec, fakeAcliSpec } from '../support/fake-acli.ts'
import { FAKE_ACLI_DIR, fakeAcliEnv } from '../support/fake-acli-env.ts'
import { callsOf } from '../support/fake-cli.ts'
import { fakeGhEnv } from '../support/fake-gh-env.ts'

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

const SPEC: FakeAcliSpec = fakeAcliSpec('e2e.atlassian.net', [
  {
    key: 'ABC-1',
    summary: 'Fake work item',
    issueType: 'Task',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    subtasks: [
      { key: 'ABC-2', summary: 'Fake subtask', issueType: 'Sub-task', status: 'To Do', statusCategory: 'new' },
    ],
  },
])

const VIEW_FIELDS = 'issuetype,status,summary,parent,subtasks'
const body = (stdout: string) => JSON.parse(stdout)

test('--version succeeds, so the mod finds an acli', () => {
  const r = answer(['--version'], SPEC)
  assert.equal(r.exitCode, 0)
  assert.match(r.stdout, /^acli version \S+/)
  assert.equal(r.call, '--version')
})

test('jira auth status names the one site in the lines the mod parses', () => {
  const r = answer(['jira', 'auth', 'status'], SPEC)
  assert.equal(r.exitCode, 0)
  assert.equal(r.call, 'jira auth status')
  assert.match(r.stdout, /^\s*Site:\s*e2e\.atlassian\.net$/m)
})

test('a spec with no site is logged out: auth status says unauthorized and view fails as acli does', () => {
  const out = fakeAcliSpec(null, [])
  const status = answer(['jira', 'auth', 'status'], out)
  assert.equal(status.exitCode, 1)
  assert.match(status.stderr, /unauthorized: use 'acli jira auth login'/)
  assert.equal(status.call, 'jira auth status')
  const view = answer(['jira', 'workitem', 'view', 'ABC-1', '--json'], out)
  assert.equal(view.exitCode, 1)
  assert.match(view.stderr, /failed to fetch work item details/)
  assert.equal(view.call, 'jira workitem view')
})

test('view --json prints one Jira REST object with the fields the mod reads and the subtasks', () => {
  const r = answer(['jira', 'workitem', 'view', 'ABC-1', '--fields', VIEW_FIELDS, '--json'], SPEC)
  assert.equal(r.exitCode, 0)
  assert.equal(r.call, 'jira workitem view')
  const json = body(r.stdout)
  assert.equal(json.key, 'ABC-1')
  assert.equal(json.fields.summary, 'Fake work item')
  assert.equal(json.fields.issuetype.name, 'Task')
  assert.equal(json.fields.status.name, 'In Progress')
  assert.equal(json.fields.status.statusCategory.key, 'indeterminate')
  assert.equal(json.fields.subtasks.length, 1)
  assert.equal(json.fields.subtasks[0].key, 'ABC-2')
  assert.equal(json.fields.subtasks[0].fields.summary, 'Fake subtask')
})

test('view answers a key given after the flags, and a call of the model with no flag at all', () => {
  const after = answer(['jira', 'workitem', 'view', '--json', '--fields', VIEW_FIELDS, 'ABC-1'], SPEC)
  assert.equal(body(after.stdout).key, 'ABC-1')
  const plain = answer(['jira', 'workitem', 'view', 'ABC-1'], SPEC)
  assert.equal(plain.exitCode, 0)
  assert.equal(plain.call, 'jira workitem view')
  assert.match(plain.stdout, /ABC-1/)
  assert.match(plain.stdout, /Fake work item/)
})

test('--fields limits the fields as acli does, and the key stays', () => {
  const json = body(answer(['jira', 'workitem', 'view', 'ABC-1', '--fields', 'summary', '--json'], SPEC).stdout)
  assert.equal(json.key, 'ABC-1')
  assert.deepEqual(Object.keys(json.fields), ['summary'])
})

test('-f and --fields=VALUE limit the fields as --fields VALUE does, and plain view ignores --fields', () => {
  for (const argv of [['-f', 'summary'], ['--fields=summary']]) {
    const json = body(answer(['jira', 'workitem', 'view', 'ABC-1', ...argv, '--json'], SPEC).stdout)
    assert.deepEqual(Object.keys(json.fields), ['summary'], argv.join(' '))
  }
  const plain = answer(['jira', 'workitem', 'view', 'ABC-1', '--fields', 'summary'], SPEC)
  assert.equal(plain.exitCode, 0)
  assert.match(plain.stdout, /^Key: ABC-1\n/)
})

test('view of a key the fake does not know fails as acli does for an unknown key', () => {
  const r = answer(['jira', 'workitem', 'view', 'ZZZ-9', '--json'], SPEC)
  assert.equal(r.exitCode, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /Issue does not exist or you do not have permission to see it\./)
  assert.equal(r.call, 'jira workitem view')
})

test('view with no key fails as acli does', () => {
  const r = answer(['jira', 'workitem', 'view', '--json'], SPEC)
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /argument \[key\] is required/)
})

test('any other call is unsupported: exit 1, a message, and a name for the log', () => {
  for (const argv of [
    ['jira', 'workitem', 'search', '--jql', 'parent = ABC-1'],
    ['jira', 'workitem', 'edit', '--key', 'ABC-1'],
    ['jira', 'auth', 'switch', '--site', 'x'],
    ['auth', 'login'],
    [],
  ]) {
    const r = answer(argv, SPEC)
    assert.equal(r.exitCode, 1, argv.join(' '))
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /fake acli: unsupported call/)
    assert.equal(r.call, 'unsupported')
  }
})

test('FAKE_ACLI_CALLS names every call that answer() logs, except unsupported', () => {
  const argvs = [['--version'], ['jira', 'auth', 'status'], ['jira', 'workitem', 'view', 'ABC-1']]
  assert.deepEqual(
    argvs.map(a => answer(a, SPEC).call),
    [...FAKE_ACLI_CALLS],
  )
})

test('fakeAcliSpec rejects a site that is no host, and a key that is no Jira key', () => {
  assert.throws(() => fakeAcliSpec('https://e2e.atlassian.net', []), /host/)
  assert.throws(() => fakeAcliSpec('e2e.atlassian.net', [{ ...SPEC.items[0]!, key: 'abc-1' }]), /key/)
})

test('fakeAcliEnv puts the shim dir first on PATH, keeps the rest, and names the spec and the log', () => {
  const env = fakeAcliEnv({ specFile: '/s.json', logFile: '/l.log' }, '/usr/bin:/bin')
  assert.equal(env.PATH, [`${FAKE_ACLI_DIR}/bin`, '/usr/bin:/bin'].join(delimiter))
  assert.equal(env.FAKE_ACLI_SPEC, '/s.json')
  assert.equal(env.FAKE_ACLI_LOG, '/l.log')
  assert.equal(env.FAKE_ACLI_NODE, process.execPath)
})

test('fakeAcliEnv blanks the Atlassian credentials, so a token of the caller gives claude no way to reach Jira', () => {
  const env = fakeAcliEnv({ specFile: '/s.json', logFile: '/l.log' }, '/bin')
  for (const name of ['ATLASSIAN_API_TOKEN', 'JIRA_API_TOKEN', 'ACLI_API_TOKEN']) assert.equal(env[name], '', name)
})

test('the shim dir holds acli alone, so the fake gh and the fake acli can share one PATH', () => {
  const gh = fakeGhEnv({ specFile: '/a', logFile: '/b' }, '/bin')
  const both = fakeAcliEnv({ specFile: '/s', logFile: '/l' }, gh.PATH)
  const find = (name: string) =>
    execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env: { PATH: both.PATH } }).trim()
  assert.equal(find('acli'), join(FAKE_ACLI_DIR, 'bin', 'acli'))
  assert.match(find('gh'), /fake-gh\/bin\/gh$/)
})

// The shim as claude runs it: a program named acli, first on PATH, that reads FAKE_ACLI_SPEC.
function shim(args: string[], env: Record<string, string | undefined>) {
  const result = spawnSync(join(FAKE_ACLI_DIR, 'bin', 'acli'), args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, FAKE_ACLI_NODE: process.execPath, ...env },
  })
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('the acli shim answers from the spec file and logs one line per call', () => {
  const dir = tempDir('fake-acli-')
  const specFile = join(dir, 'fake-acli.json')
  const logFile = join(dir, 'fake-acli.log')
  writeFileSync(specFile, JSON.stringify(SPEC))
  const env = { FAKE_ACLI_SPEC: specFile, FAKE_ACLI_LOG: logFile }

  assert.match(shim(['--version'], env).stdout, /^acli version/)
  const view = shim(['jira', 'workitem', 'view', 'ABC-1', '--json'], env)
  assert.equal(view.exitCode, 0)
  assert.equal(body(view.stdout).key, 'ABC-1')
  const other = shim(['jira', 'workitem', 'search', '--jql', 'x'], env)
  assert.equal(other.exitCode, 1)
  assert.match(other.stderr, /unsupported call: jira workitem search --jql x/)

  const calls = callsOf(readFileSync(logFile, 'utf8'))
  assert.deepEqual(
    calls.map(c => [c.call, c.exit]),
    [
      ['--version', 0],
      ['jira workitem view', 0],
      ['unsupported', 1],
    ],
  )
  assert.deepEqual(calls[1]?.argv, ['jira', 'workitem', 'view', 'ABC-1', '--json'])
})

test('the acli shim names an unreadable or corrupt spec file and exits 2, as it does for no spec', () => {
  const dir = tempDir('fake-acli-')
  const corrupt = join(dir, 'corrupt.json')
  writeFileSync(corrupt, '{not json')
  for (const specFile of [join(dir, 'missing.json'), corrupt]) {
    const r = shim(['--version'], { FAKE_ACLI_SPEC: specFile })
    assert.equal(r.exitCode, 2, specFile)
    assert.match(r.stderr, /^fake acli: cannot read FAKE_ACLI_SPEC: /)
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace')
  }
})

test('the acli shim logs nothing and still answers when FAKE_ACLI_LOG is not set', () => {
  const dir = tempDir('fake-acli-')
  const specFile = join(dir, 'fake-acli.json')
  writeFileSync(specFile, JSON.stringify(SPEC))
  assert.equal(shim(['--version'], { FAKE_ACLI_SPEC: specFile }).exitCode, 0)
})

test('the acli shim refuses to answer without a spec, so a stray PATH never fakes Jira silently', () => {
  const r = shim(['--version'], {})
  assert.equal(r.exitCode, 2)
  assert.match(r.stderr, /fake acli: FAKE_ACLI_SPEC is not set/)
})

test('the acli shim is the file the env names, found by PATH like claude finds acli', () => {
  const env = fakeAcliEnv({ specFile: '/nowhere', logFile: '/nowhere.log' }, process.env.PATH ?? '')
  const found = execFileSync('/bin/sh', ['-c', 'command -v acli'], { encoding: 'utf8', env }).trim()
  assert.equal(found, join(FAKE_ACLI_DIR, 'bin', 'acli'))
})

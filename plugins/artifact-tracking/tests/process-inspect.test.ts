// The pure part of `docker rm` for `/track clean --yes containers` (issue #123, PR 2): the one `docker container inspect
// --format` line, its parser, the reading of `Created`, and the check that the container is the one the row names and that
// this run made. No Docker runs here. The shapes are the ones the design study saw (part 2, L101 to L144).
import { expect, test } from 'claude-code/testing'
import { parseBashProcesses } from '../trackers/processes/parse'
import {
  containerKeepReason,
  createdMs,
  hasOwnName,
  INSPECT_FORMAT,
  type InspectedContainer,
  NO_OWN_NAME,
  NOT_ALONE,
  nameOfId,
  parseInspectLine,
  SPAWN_WINDOW_MS,
} from '../trackers/processes/probe'

const ID = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const TAB = '\t'
/** A full answer of `docker container inspect --format INSPECT_FORMAT`, with real tabs. */
const answer = (f: Partial<Record<'id' | 'status' | 'created' | 'name' | 'labels', string>> = {}): string =>
  [
    f.id ?? ID,
    f.status ?? 'exited',
    f.created ?? '2026-10-26T08:31:11.02472799Z',
    f.name ?? '/probe-s123-fmt',
    f.labels ?? '{}',
  ].join(TAB) + '\n'

const parsed = (f: Parameters<typeof answer>[0] = {}): InspectedContainer => {
  const got = parseInspectLine(answer(f))
  if (got === undefined) throw new Error('the line did not parse')
  return got
}

// ---------------------------------------------------------------- the format

test('the inspect format is one line with five fields, joined by real tabs (not the two characters \\t)', () => {
  expect(INSPECT_FORMAT).toBe('{{.Id}}\t{{.State.Status}}\t{{.Created}}\t{{.Name}}\t{{json .Config.Labels}}')
  expect(INSPECT_FORMAT.includes(TAB)).toBe(true)
  expect(INSPECT_FORMAT.includes('\\t')).toBe(false)
})

// ---------------------------------------------------------------- the line

test('parseInspectLine reads the observed line of the study: id, status, created, name and the label keys', () => {
  // L142 of the study: a label key with a suffix, set by hand in the probe.
  expect(
    parseInspectLine(
      `${ID}${TAB}exited${TAB}2026-10-26T08:31:11.02472799Z${TAB}/probe-s123-fmt${TAB}{"org.testcontainers.sessionId":"x"}\n`,
    ),
  ).toEqual({
    id: ID,
    status: 'exited',
    created: '2026-10-26T08:31:11.02472799Z',
    name: '/probe-s123-fmt',
    labels: ['org.testcontainers.sessionId'],
  })
  // L105: no labels print as `{}`. A container with no label map can print `null`.
  expect(parsed().labels).toEqual([])
  expect(parsed({ labels: 'null' }).labels).toEqual([])
  expect(parsed({ labels: '{"a":"1","b.c":"2"}' }).labels).toEqual(['a', 'b.c'])
})

test('parseInspectLine gives nothing for an answer it cannot trust: other field counts, labels that are no object, two lines', () => {
  expect(parseInspectLine('')).toBeUndefined()
  expect(parseInspectLine(`${ID}${TAB}exited\n`)).toBeUndefined()
  expect(parseInspectLine(`${answer().trim()}${TAB}extra\n`)).toBeUndefined()
  expect(parseInspectLine(answer({ labels: 'not json' }))).toBeUndefined()
  expect(parseInspectLine(answer({ labels: '["a"]' }))).toBeUndefined()
  expect(parseInspectLine(answer({ labels: '"text"' }))).toBeUndefined()
  // Two lines: the runner may have glued the answers of two containers. Only one line is an answer.
  expect(parseInspectLine(answer() + answer({ id: OTHER }))).toBeUndefined()
  // The same line in the form `docker` prints with Windows line ends is still the line.
  expect(parseInspectLine(answer().replace('\n', '\r\n'))?.id).toBe(ID)
})

// ---------------------------------------------------------------- `Created`

test('createdMs cuts the fraction to 3 digits first: the engine runtime is not node (G19)', () => {
  // L410 of the study: node 24 reads nanoseconds. The cut makes the same value on a runtime that does not.
  expect(createdMs('2026-10-26T08:24:08.81631008Z')).toBe(1793003048816)
  expect(createdMs('2026-10-26T08:24:08.816Z')).toBe(1793003048816)
  expect(createdMs('2026-10-26T08:24:08Z')).toBe(1793003048000)
  // A short fraction is padded, not read as a fraction of another size.
  expect(createdMs('2026-10-26T08:24:08.5Z')).toBe(1793003048500)
  expect(createdMs('2026-10-26T08:24:08.81Z')).toBe(1793003048810)
})

test('createdMs gives nothing for text that is no date', () => {
  expect(createdMs('garbage')).toBeUndefined()
  expect(createdMs('')).toBeUndefined()
  expect(createdMs('2026-13-45T99:99:99Z')).toBeUndefined()
})

// ---------------------------------------------------------------- the check

const T0 = 1793003048816
const row = (f: { containerId?: string; name?: string; firstSeen?: number; alone?: boolean } = {}) => ({
  containerId: f.containerId ?? ID,
  name: f.name ?? 'probe-s123-fmt', // a row of a `--name` run: the container of `answer()` has this name
  firstSeen: f.firstSeen ?? T0 + 100,
  ...(f.alone === false ? {} : { containerRunAlone: true as const }), // the run was alone in its call, unless a test says it was not
})

test('a container that is the row, has exited and was created inside the window has no reason to be kept', () => {
  expect(containerKeepReason(row(), parsed())).toBeUndefined()
})

// The parser and the check share one rule for the name of a row that has no `--name`: `nameOfId`. A row with no `--name` has no
// name of its own, so nothing but its id says that the run made the container. The id can be another command's output (the known
// limits of the pairing: a run that failed or never ran), so such a row is kept, whatever name and age the container has (review
// of PR 285, P1). If `nameOfId` changes, the parser's unnamed row must still read as unnamed.
test('a row that the parser names by its id has no name of its own, and its container is kept', () => {
  const [made] = parseBashProcesses('docker run -d alpine sleep 9', { result: { stdout: `${ID}\n` } })
  expect(made?.name).toBe(nameOfId(ID))
  const unnamed = { containerId: ID, name: made?.name ?? '', firstSeen: T0 + 100 }
  expect(hasOwnName(unnamed)).toBe(false)
  expect(containerKeepReason(unnamed, parsed({ name: '/gallant_curie' }))).toBe(NO_OWN_NAME)
  // The name of the container does not help: a container that happens to carry the name of the id is no proof either.
  expect(containerKeepReason(unnamed, parsed({ name: `/${nameOfId(ID)}` }))).toBe(NO_OWN_NAME)
  const [named] = parseBashProcesses('docker run -d --name api alpine sleep 9', { result: { stdout: `${ID}\n` } })
  expect(hasOwnName({ containerId: ID, name: named?.name ?? '' })).toBe(true)
})

// A row whose run was not alone in its call (`containerRunAlone` is missing) is kept, whatever name and age the container has
// (review of PR 285, P1 again): the name of the row can be the name of a container that the run never made, because Docker keeps
// names unique, so a run that failed on a taken name pairs with the id of the old container that holds it.
test('a row whose run was not alone in its call has its container kept, also when the name and the age fit', () => {
  const [made] = parseBashProcesses(`false && docker run -d --name api nginx; printf '%s\\n' ${ID}`, {
    result: { stdout: `${ID}\n` },
  })
  expect(made).toMatchObject({ name: 'api', containerId: ID, containerIdExact: true })
  expect(made?.containerRunAlone).toBeUndefined()
  const fromCall = { containerId: ID, name: 'api', firstSeen: T0 + 100, containerRunAlone: made?.containerRunAlone }
  expect(containerKeepReason(fromCall, parsed({ name: '/api', created: '2026-10-26T08:31:11.02472799Z' }))).toBe(
    NOT_ALONE,
  )
  const [lone] = parseBashProcesses('docker run -d --name api nginx', { result: { stdout: `${ID}\n` } })
  expect(lone?.containerRunAlone).toBe(true)
  const fromLone = { containerId: ID, name: 'api', firstSeen: T0 + 100, containerRunAlone: lone?.containerRunAlone }
  expect(containerKeepReason(fromLone, parsed({ name: '/api' }))).toBeUndefined()
})

test('the checks run in the order of the study: id, status, label, creation time, name', () => {
  // Every field is wrong at once. The first check that fails is the answer.
  const bad = parsed({
    id: OTHER,
    status: 'running',
    created: 'garbage',
    name: '/x',
    labels: '{"org.testcontainers":"true"}',
  })
  expect(containerKeepReason(row({ name: 'api' }), bad)).toBe('docker named another container')
  const sameId = { ...bad, id: ID }
  expect(containerKeepReason(row({ name: 'api' }), sameId)).toBe('the container is running')
  const exited = { ...sameId, status: 'exited' }
  expect(containerKeepReason(row({ name: 'api' }), exited)).toBe('managed by Testcontainers')
  const plain = { ...exited, labels: [] }
  expect(containerKeepReason(row({ name: 'api' }), plain)).toBe('cannot read the creation time')
  const dated = { ...plain, created: '2026-10-26T08:24:08.81631008Z' }
  expect(containerKeepReason(row({ name: 'api' }), dated)).toBe('the name is not api')
  expect(containerKeepReason(row({ name: 'api' }), { ...dated, name: '/api' })).toBeUndefined()
  // A row whose run was not alone fails after the creation time and before the name of the container: the name cannot vouch for it.
  expect(containerKeepReason(row({ name: 'api', alone: false }), { ...dated, name: '/api' })).toBe(NOT_ALONE)
  expect(containerKeepReason(row({ name: 'api', alone: false }), plain)).toBe('cannot read the creation time')
  // A row with no `--name` fails the name step, after the other checks, whatever the container is called. It is named first.
  expect(containerKeepReason(row({ name: nameOfId(ID), alone: false }), { ...dated, name: '/api' })).toBe(NO_OWN_NAME)
  expect(containerKeepReason(row({ name: nameOfId(ID) }), { ...dated, name: '/api' })).toBe(NO_OWN_NAME)
  expect(containerKeepReason(row({ name: nameOfId(ID) }), plain)).toBe('cannot read the creation time')
})

test('a label key that starts with org.testcontainers keeps the container, with or without a suffix', () => {
  const keep = 'managed by Testcontainers'
  expect(containerKeepReason(row(), parsed({ labels: '{"org.testcontainers":"true"}' }))).toBe(keep)
  expect(containerKeepReason(row(), parsed({ labels: '{"org.testcontainers.sessionId":"x"}' }))).toBe(keep)
  expect(containerKeepReason(row(), parsed({ labels: '{"app":"a","org.testcontainers.lang":"java"}' }))).toBe(keep)
  // A key that only contains the word, or another prefix, is none of them.
  expect(containerKeepReason(row(), parsed({ labels: '{"com.org.testcontainers":"x","testcontainers":"y"}' }))).toBe(
    undefined,
  )
})

test('only an exited container is removed: created, running, paused, restarting, dead and removing are kept', () => {
  for (const status of ['created', 'running', 'paused', 'restarting', 'removing', 'dead'])
    expect(containerKeepReason(row(), parsed({ status }))).toBe(`the container is ${status}`)
  expect(containerKeepReason(row(), parsed({ status: 'exited' }))).toBeUndefined()
})

test('the window has a lower bound and no upper bound: firstSeen less 11 minutes, created long after is fine', () => {
  expect(SPAWN_WINDOW_MS).toBe(11 * 60_000)
  const created = (ms: number) => new Date(ms).toISOString()
  const seen = T0 + 100_000
  // 3088 ms before the end of the Bash call (S1 L103) passes: the call ran on after `docker run -d`.
  expect(containerKeepReason(row({ firstSeen: seen }), parsed({ created: created(seen - 3088) }))).toBeUndefined()
  // Exactly at the lower bound passes; one millisecond before it does not.
  expect(
    containerKeepReason(row({ firstSeen: seen }), parsed({ created: created(seen - SPAWN_WINDOW_MS) })),
  ).toBeUndefined()
  expect(containerKeepReason(row({ firstSeen: seen }), parsed({ created: created(seen - SPAWN_WINDOW_MS - 1) }))).toBe(
    'created before the row was seen',
  )
  // A `--name` row that ran again days later keeps its first `firstSeen`, and its new container is created long after.
  expect(
    containerKeepReason(row({ firstSeen: seen }), parsed({ created: created(seen + 3 * 86_400_000) })),
  ).toBeUndefined()
})

test('a named row needs the name of the container: a name of another container, or none, keeps it', () => {
  const named = row({ name: 'api' })
  expect(containerKeepReason(named, parsed({ name: '/api' }))).toBeUndefined()
  expect(containerKeepReason(named, parsed({ name: '/web' }))).toBe('the name is not api')
  expect(containerKeepReason(named, parsed({ name: 'api' }))).toBe('the name is not api') // docker prints the slash
  expect(containerKeepReason(named, parsed({ name: '/api2' }))).toBe('the name is not api')
  expect(containerKeepReason(named, parsed({ name: '/' }))).toBe('the name is not api')
})

test('the id is compared in full: a row with a short or an upper-case id is another container', () => {
  expect(containerKeepReason(row({ containerId: ID.slice(0, 12) }), parsed())).toBe('docker named another container')
  expect(containerKeepReason(row({ containerId: ID.toUpperCase() }), parsed())).toBe('docker named another container')
})

// Wiring tests: rows in, `/track` text, pane and band out. The kit stubs sit beneath the mod.
// The kit does not reset `$.state` on a new session id. A test that needs it passes `isolateState`: the stub then keeps
// the state per id, which is what a real /clear does. The live smoke run covers the rest.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionAppendInput } from 'claude-code'
import { LIMITS } from '../hooks/contracts'
import type { ItemRecord } from '../hooks/contracts'
import * as acliFx from './fixtures/acli'
import * as ghFx from './fixtures/gh'

const SESSION = 'sess-1'
/** The session id the stub answers. A test sets it to what `/clear` would do. */
const current = { id: SESSION }

// The hooks runtime has timers; tsc here has no DOM or node types.
declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Res = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const res = (stdout = '', exitCode = 0, stderr = ''): Res => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

// ---------------------------------------------------------------- fake gh and acli

const SAMPLE = (JSON.parse(ghFx.BATCH_SAMPLE_OUTPUT) as { data: Record<string, { issueOrPullRequest: Record<string, unknown> }> }).data
const ISSUE = SAMPLE.a!.issueOrPullRequest
/** What the fake GraphQL answers, by `owner/repo#N` (lower case). */
const NODES: Record<string, unknown> = {
  'cli/cli#14640': SAMPLE.b!.issueOrPullRequest,
  'acme/web#5': { ...ISSUE, number: 5, title: 'Web five', state: 'OPEN', stateReason: null },
  'acme/web#9': { ...ISSUE, number: 9, title: 'Web nine', state: 'OPEN', stateReason: null },
}

const ACLI_AUTH = `✓ Authenticated
  Site: acme.atlassian.net
  Email: <email>
  Authentication Type: oauth_global
`

function withKey(json: string, key: string): string {
  const o = JSON.parse(json) as { key: string }
  o.key = key
  return JSON.stringify(o)
}

type Opts = {
  seed?: Record<string, unknown>
  messages?: unknown[]
  /** `$.session.repo()` answer. */
  remote?: string | null
  /** Tools that cannot start. */
  missing?: string[]
  /** The first n `gh api graphql` calls exit 4 (not logged in). */
  ghAuthFails?: number
  /** `gh api graphql` answers `{data:{}}`: ok, but nothing about the items. The items stay due. */
  ghSilent?: boolean
  /** `acli --version` answers after this many ms (the real one takes about 600). */
  acliProbeMs?: number
  /** `gh auth status --hostname <h>` exits 1 for these hosts. */
  badHosts?: string[]
  /** `gh auth status` answers after this many ms. */
  authMs?: number
  /** `gh repo view` stdout. The default fixture names no usable repo. */
  repoView?: string
  /** Every `gh api graphql` call answers after this many ms. */
  ghDelayMs?: number
  /** Keep `$.state` per session id: a new id reads an empty state, as after a real /clear. */
  isolateState?: boolean
  /** Ids the stub `$.ui.panes()` lists (the engine keeps panes across a hot reload). */
  panes?: string[]
  /** The first n writes of the `items` atom are refused. Needs `isolateState`. */
  denyItemWrites?: number
  /** The first `clock.after` with this delay is refused: the call returns, its fn never runs. */
  refuseAfter?: number
  /** `command.register` is refused. */
  denyRegister?: boolean
}

/** Stubs for the engine nouns the mod calls. Register before the first call on `$`. */
function world(on: On, opts: Opts = {}) {
  // `mock.clock` owns the `clock.after` handler. To refuse one call, wrap that handler as it registers.
  let refused = false
  const clockOn = ((name: string, ...rest: unknown[]) => {
    const h = rest[rest.length - 1] as (...a: unknown[]) => unknown
    if (name !== 'clock.after' || opts.refuseAfter === undefined) return (on as (...a: unknown[]) => unknown)(name, ...rest)
    return (on as (...a: unknown[]) => unknown)(name, ...rest.slice(0, -1), (...a: unknown[]) => {
      if (!refused && (a[1] as { ms: number }).ms === opts.refuseAfter) {
        refused = true
        return { deny: 'refused' }
      }
      return h(...a)
    })
  }) as unknown as On
  const clock = mock.clock(clockOn)
  const store = new Map<string, unknown>(Object.entries(opts.seed ?? {}))
  const calls: string[][] = []
  const state = { ghAuthFails: opts.ghAuthFails ?? 0 }
  const registered: { name: string; argumentHint?: string }[] = []
  const opened: unknown[] = []

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  current.id = SESSION
  on('session.id', () => ({ value: current.id }))
  on('session.messages', () => ({ value: (opts.messages ?? []) as never }))
  on('session.repo', () => ({
    value: opts.remote === null ? null : { root: '/r', remote: opts.remote ?? 'git@github.com:acme/web.git', internal: false, name: null },
  }))
  on('command.register', (_$, e) => {
    if (opts.denyRegister) return { deny: 'refused' }
    registered.push({ name: e.name, argumentHint: e.argumentHint })
    return { value: { command: e.name } }
  })
  if (opts.panes) {
    on('ui.panes', () => ({ value: opts.panes!.map((id) => ({ id, title: id, isShown: true, isFocused: false })) as never }))
  }
  // The real engine resets `$.state` on /clear. Here a state lives under the session id the stub answers.
  const states = new Map<string, { value: unknown; version: number }>()
  let itemWrites = 0
  if (opts.isolateState) {
    const at = (e: { plugin: string; key: string; id?: string }) => `${current.id}|${e.plugin}|${e.key}|${e.id ?? ''}`
    on('state.get', (_$, e) => {
      const s = states.get(at(e))
      return { value: { value: s?.value, version: s?.version ?? 0 } as never }
    })
    on('state.set', (_$, e) => {
      if (e.key === 'items' && itemWrites++ < (opts.denyItemWrites ?? 0)) return { deny: 'refused' }
      const cur = states.get(at(e))
      const version = cur?.version ?? 0
      if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
      states.set(at(e), { value: JSON.parse(JSON.stringify(e.value ?? null)), version: version + 1 })
      return { value: { isSet: true, version: version + 1 } }
    })
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })

  const graphql = (query: string): Res => {
    if (state.ghAuthFails > 0) {
      state.ghAuthFails -= 1
      return res('', 4, ghFx.AUTH_UNAUTH_STDERR)
    }
    if (opts.ghSilent) return res('{"data":{}}')
    const data: Record<string, unknown> = {}
    const re = /(a\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{\s*issueOrPullRequest\(number: (\d+)\)/g
    for (const m of query.matchAll(re)) data[m[1]!] = { issueOrPullRequest: NODES[`${m[2]}/${m[3]}#${m[4]}`] ?? null }
    return res(JSON.stringify({ data }))
  }

  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const [tool, a1, a2, a3, a4] = argv
    if (tool === 'acli' && a1 === '--version' && opts.acliProbeMs) await sleep(opts.acliProbeMs)
    if (opts.missing?.includes(tool!)) return { deny: 'ENOENT: Executable not found in $PATH' }
    if (a1 === '--version') return { value: res(tool === 'gh' ? 'gh version 2.102.0 (2026-09-30)' : 'acli version 1.3.19-stable') }
    if (tool === 'gh' && a1 === 'api' && a2 === 'graphql') {
      if (opts.ghDelayMs) await sleep(opts.ghDelayMs)
      return { value: graphql(argv.find((x) => x.startsWith('query='))?.slice('query='.length) ?? '') }
    }
    if (tool === 'gh' && a1 === 'auth') {
      if (opts.authMs) await sleep(opts.authMs)
      return { value: opts.badHosts?.includes(a4!) ? res('', 1, ghFx.GHE_AUTH_STATUS_STDERR) : res('Logged in') }
    }
    if (tool === 'gh' && a1 === 'repo') return { value: res(opts.repoView ?? ghFx.REPO_RESOLUTION_STDOUT) }
    if (tool === 'acli' && a2 === 'auth') return { value: res(ACLI_AUTH) }
    if (tool === 'acli' && a3 === 'view') return { value: res(withKey(acliFx.TASK_VIEW_JSON, a4!)) }
    return { value: res('', 1, 'unexpected call: ' + argv.join(' ')) }
  })

  return { clock, store, calls, state, registered, opened, states }
}

const graphqlCalls = (calls: string[][]) => calls.filter((c) => c[0] === 'gh' && c[1] === 'api')
const viewCalls = (calls: string[][]) => calls.filter((c) => c[0] === 'acli' && c[3] === 'view')

/** Waits until no new process.run call has come for a while: the refresh and its save are done. */
async function quiet(calls: unknown[]): Promise<void> {
  let stable = 0
  let last = -1
  for (let i = 0; i < 200 && stable < 4; i++) {
    await sleep(10)
    stable = calls.length === last ? stable + 1 : 0
    last = calls.length
  }
}

const track = ($: Engine, args = '') =>
  $.command.run({ command: 'track', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

// ---------------------------------------------------------------- rows

let seq = 0
const uuid = () => 'u' + ++seq

const prompt = (text: string, kind = 'composer', extra: { isMeta?: true; agentId?: string } = {}): SessionAppendInput =>
  ({
    door: 'prompt',
    origin: { kind } as never,
    uuid: uuid(),
    agentId: extra.agentId,
    message: { type: 'user', role: 'user', isMeta: extra.isMeta, content: [{ type: 'text', text }] },
  })

const commandRow = (text: string, kind: 'composer' | 'engine'): SessionAppendInput =>
  ({
    door: 'command',
    origin: { kind },
    uuid: uuid(),
    message: { type: kind === 'engine' ? 'system' : 'user', role: 'user', content: [{ type: 'text', text }] },
  }) as SessionAppendInput

const response = (text: string): SessionAppendInput =>
  ({
    door: 'response',
    origin: { kind: 'model', model: 'm' },
    uuid: uuid(),
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  })

const toolResult = (content: unknown): SessionAppendInput =>
  ({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: uuid(),
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content }] },
  })

const START = { cwd: '/work', surface: null, isInteractive: false } as const

const PANE = {
  plugin: 'artifact-tracking',
  component: 'Pane',
  requestId: 'track',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'Tracking', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} },
} as const

const BAND = {
  plugin: 'artifact-tracking',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 90, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

// ---------------------------------------------------------------- capture and refresh

test('prompt row: #5 and a Jira URL are listed by /track with refreshed status', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('Look at #5 and https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('#5')
  expect(text).toContain('Web five')
  expect(text).toContain('ISS-1')
  expect(text).toContain('Draft')
  expect(graphqlCalls(calls).length).toBe(1)
  expect(viewCalls(calls).map((c) => c[4])).toEqual(['ISS-1'])
})

test('a later row with a new item refreshes it after the capture debounce', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('first #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(1)
  await $.session.append(prompt('and now #9'))
  expect(graphqlCalls(calls).length).toBe(1) // the debounce has not run yet
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(2)
  expect((await track($)).text).toContain('Web nine')
})

test('rows of other makers are not captured: task notification, isMeta, subagent, coordinator', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('done: https://github.com/cli/cli/pull/14640 and #5', 'task-notification'))
  await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-2', 'composer', { isMeta: true }))
  await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-3', 'composer', { agentId: 'agent-7' }))
  await $.session.append(prompt('go and read #6', 'coordinator'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toBe('No tracked items yet.')
  expect(graphqlCalls(calls).length).toBe(0)
})

test('command rows: our own engine output is skipped, a composer command is read from its args', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(
    commandRow('<command-name>/track</command-name>\n<command-args>#77</command-args>', 'engine'),
  )
  await $.session.append(
    commandRow('<local-command-stdout>Jira  ISS-77  #77 https://leak.example/x</local-command-stdout>', 'engine'),
  )
  await $.session.append(
    commandRow('<command-message>foo</command-message>\n<command-name>/foo https://outside.example/o</command-name>\n<command-args>#9</command-args>', 'composer'),
  )
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('#9')
  expect(text).toContain('Web nine')
  expect(text).not.toContain('ISS-77')
  expect(text).not.toContain('#77')
  expect(text).not.toContain('leak.example')
  expect(text).not.toContain('outside.example')
})

test('tool-result row: only explicit GitHub and Jira URLs count, never bare #N or web links', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(toolResult('see https://example.com and #7, build #8 failed'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toBe('No tracked items yet.')
  await $.session.append(toolResult([{ type: 'text', text: 'opened https://github.com/cli/cli/pull/14640 just now' }]))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('cli/cli#14640')
  expect(text).not.toContain('example.com')
  expect(text).not.toContain('#7')
})

test('response row: a web link and a PR URL are captured; the row is stored as made', async ($, on) => {
  const { clock, calls } = world(on)
  const row = response('See [the docs](https://code.claude.com/docs/en/plugins) and https://github.com/cli/cli/pull/14640.')
  const stored = await $.session.append(row)
  expect(stored.message?.content).toEqual(row.message.content)
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('the docs')
  expect(text).toContain('cli/cli#14640')
})

test('a URL and a bare #N for the same item make one item', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(prompt('check #5'))
  await $.session.append(response('Fixed https://github.com/acme/web/issues/5 already.'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text.match(/Web five/g)?.length).toBe(1)
})

test('/clear carry-over, store path: the items of the session just left come back', async ($, on) => {
  const old: ItemRecord[] = [
    { key: 'web:https://old.example/x', category: 'web', url: 'https://old.example/x', label: 'Old page', sources: ['response'], firstSeen: 1, lastSeen: 1, seenCount: 1 },
    {
      key: 'gh:github.com/acme/web#3', category: 'github', url: 'https://github.com/acme/web/issues/3', label: 'acme/web#3', sources: ['prompt'],
      firstSeen: 2, lastSeen: 2, seenCount: 1, host: 'github.com', owner: 'acme', repo: 'web', number: 3, type: 'issue', title: 'Old three', state: 'closed',
      refreshedAt: Date.now(),
    },
  ]
  const { clock, calls } = world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { items: old } } })
  await $.session.append(prompt('first https://example.org/a')) // learns the id; no session.start, so nothing is restored
  current.id = 'sess-2' // what /clear does
  await $.session.append(prompt('then #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Old page')
  expect(text).toContain('Old three')
  expect(text).toContain('Web five')
  expect(text).toContain('example.org/a')
})

test('/clear carry-over also happens on /track alone', async ($, on) => {
  const old: ItemRecord[] = [
    { key: 'web:https://old.example/x', category: 'web', url: 'https://old.example/x', label: 'Old page', sources: ['response'], firstSeen: 1, lastSeen: 1, seenCount: 1 },
  ]
  world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { items: old } } })
  await $.session.append(prompt('first https://example.org/a'))
  current.id = 'sess-2'
  expect((await track($)).text).toContain('Old page')
})

test('/track refresh clears a logged-out gh and asks again', async ($, on) => {
  const { clock, calls } = world(on, { ghAuthFails: 1 })
  await $.session.append(response('PR: https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(1)
  const before = (await track($)).text ?? ''
  expect(before).toContain('not logged in')
  expect(graphqlCalls(calls).length).toBe(1) // opening the pane makes no more gh calls
  const after = (await track($, 'refresh')).text ?? ''
  expect(graphqlCalls(calls).length).toBe(2)
  expect(after).not.toContain('not logged in')
  expect(after).toContain('✗ checks')
})

test('a tool that is not installed is named in its section; the other tool still works', async ($, on) => {
  const { clock, calls } = world(on, { missing: ['acli'] })
  await $.session.append(prompt('see #5 and https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('not installed')
  expect(text).toContain('Web five')
  expect(text).toContain('ISS-1')
})

test('tool-result row of 1 MB settles fast, is stored whole, and a URL near its start is captured', async ($, on) => {
  const { clock, calls } = world(on)
  const big = 'https://github.com/cli/cli/pull/14640 ' + 'x'.repeat(1_000_000)
  const t0 = Date.now()
  const stored = await $.session.append(toolResult(big))
  expect(Date.now() - t0).toBeLessThan(3000)
  const block = (stored.message?.content as unknown as { content: string }[])[0]!
  expect(block.content.length).toBe(big.length)
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toContain('cli/cli#14640')
})

// ---------------------------------------------------------------- session start, store, commands

test('session.start registers /track with its hint', async ($, on) => {
  const { registered } = world(on)
  await $.session.start(START)
  expect(registered).toEqual([{ name: 'track', argumentHint: '[refresh|clear]' }])
})

test('session.start backfills from the transcript with the same rules per role', async ($, on) => {
  world(on, {
    messages: [
      { role: 'user', text: 'please look at #5', toolUses: [] },
      { role: 'user', text: '<local-command-stdout>ISS-88 #88</local-command-stdout>', toolUses: [] },
      { role: 'user', text: '<command-message>foo</command-message>\n<command-name>/foo https://outside.example/o</command-name>\n<command-args>#9 and #10</command-args>', toolUses: [] },
      { role: 'assistant', text: 'It is in [docs](https://docs.example/a) and #6', toolUses: [] },
      {
        role: 'assistant', text: '',
        toolUses: [{ tool_use_id: 't', tool: 'Bash', input: {}, text: 'https://github.com/cli/cli/pull/14640 and #11 and https://tool.example/w' }],
      },
    ],
  })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toContain('#5')
  expect(text).toContain('docs.example/a')
  expect(text).toContain('#6')
  expect(text).toContain('cli/cli#14640')
  expect(text).toContain('#9')
  expect(text).toContain('#10')
  expect(text).not.toContain('#11')
  expect(text).not.toContain('outside.example')
  expect(text).not.toContain('tool.example')
  expect(text).not.toContain('ISS-88')
})

test('session.start restores the stored copy of a session it knows', async ($, on) => {
  const stored: ItemRecord = {
    key: 'web:https://kept.example/', category: 'web', url: 'https://kept.example/', label: 'Kept page', sources: ['response'], firstSeen: 1, lastSeen: 1, seenCount: 1,
  }
  world(on, { seed: { index: [SESSION], ['s:' + SESSION]: { items: [stored] } } })
  await $.session.start(START)
  expect((await track($)).text).toContain('Kept page')
})

test('a burst of rows makes one store write after the delay; an empty list never replaces a stored one', async ($, on) => {
  const { clock, store, calls } = world(on)
  await $.session.append(response('https://one.example/ and https://two.example/'))
  await $.session.append(response('https://three.example/'))
  expect(store.size).toBe(0)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  expect((store.get('s:' + SESSION) as { items: unknown[] }).items.length).toBe(3)
  expect(store.get('index')).toEqual([SESSION])
  await track($, 'clear')
  expect(store.has('s:' + SESSION)).toBe(false)
  await clock.advance(LIMITS.flushMs + 10)
  expect(store.has('s:' + SESSION)).toBe(false)
})

test('a flush that finds an empty list writes nothing', async ($, on) => {
  const { clock, store, calls } = world(on)
  await $.session.append(response('https://one.example/')) // schedules a flush
  await track($, 'clear') // empties the list before the flush runs
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect(store.has('s:' + SESSION)).toBe(false)
})

test('the store keeps the newest sessions only', async ($, on) => {
  const seed: Record<string, unknown> = { index: Array.from({ length: LIMITS.keepSessions + 5 }, (_, k) => 'old' + k) }
  for (const id of seed.index as string[]) seed['s:' + id] = { items: [] }
  const { clock, store } = world(on, { seed })
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  const index = store.get('index') as string[]
  expect(index.length).toBe(LIMITS.keepSessions)
  expect(index[0]).toBe(SESSION)
  expect(store.has('s:old' + (LIMITS.keepSessions + 4))).toBe(false)
})

test('/track right after the first row waits for the probes, so the sections never say "checking"', async ($, on) => {
  world(on, { acliProbeMs: 80 })
  await $.session.append(response('https://github.com/cli/cli/pull/14640 and https://acme.atlassian.net/browse/ISS-1'))
  const text = (await track($)).text ?? ''
  expect(text).not.toContain('checking')
  expect(text).toContain('ready')
})

test('/track clear empties the list; an unknown argument prints the usage', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.append(response('https://one.example/'))
  expect((await track($)).text).toContain('one.example')
  expect((await track($, 'clear')).text).toBe('Tracking list cleared.')
  expect((await track($)).text).toBe('No tracked items yet.')
  expect((await track($, 'bogus')).text).toContain('Usage: /track')
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
})

test('the tick refreshes while the pane is open (ui.close cannot be raised in the kit; the live run covers it)', async ($, on) => {
  const { clock, calls } = world(on, { ghSilent: true })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const before = graphqlCalls(calls).length
  await clock.advance(LIMITS.tickMs * 3)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(before) // no pane yet: no tick
  await track($) // opens the pane and starts the tick
  await quiet(calls)
  const opened = graphqlCalls(calls).length
  expect(opened).toBe(before + 1)
  await clock.advance(LIMITS.tickMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(opened + 1)
})

// ---------------------------------------------------------------- review fixes

const webRec = (url: string, label: string): ItemRecord => ({
  key: 'web:' + url, category: 'web', url, label, sources: ['response'], firstSeen: 1, lastSeen: 1, seenCount: 1,
})
const KEPT = webRec('https://kept.example/', 'Kept page')

type PaneUi = {
  find(q: unknown): Promise<unknown>
  unmount(): Promise<void>
}
const mountPane = ($: Engine) => $.ui.mount({ ...PANE, surface: 'terminal' } as never) as unknown as Promise<PaneUi>

test('/clear while a flush is still pending: the items are saved under the old id and carried over', async ($, on) => {
  const { clock, store, calls } = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/')) // the flush is due in flushMs
  current.id = 'sess-2' // /clear: a new id and an empty state, before the flush ran
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect((store.get('s:' + SESSION) as { items: unknown[] } | undefined)?.items.length).toBe(1)
  expect((store.get('s:sess-2') as { items: unknown[] } | undefined)?.items.length).toBe(1) // the same flush copies the carried list
  expect((await track($)).text).toContain('one.example')
})

test('the tick notices /clear and brings the items back while the pane is open', async ($, on) => {
  const { clock, calls } = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await track($) // opens the pane and starts the tick
  current.id = 'sess-2' // /clear: the command row has no args, so no capture runs
  await clock.advance(LIMITS.tickMs + 10)
  await quiet(calls)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'one.example' })).toBeDefined()
  await ui.unmount()
})

test('/resume of a known session restores that session, not the one just left', async ($, on) => {
  const { store } = world(on, {
    isolateState: true,
    seed: { index: ['sess-b'], 's:sess-b': { items: [webRec('https://beta.example/', 'beta.example')] } },
    messages: [{ role: 'assistant', text: 'see https://transcript.example/t', toolUses: [] }],
  })
  await $.session.append(response('https://alpha.example/'))
  current.id = 'sess-b' // /resume
  const text = (await track($)).text ?? ''
  expect(text).toContain('beta.example')
  expect(text).toContain('transcript.example') // the backfill runs, as at startup
  expect(text).not.toContain('alpha.example')
  expect((store.get('s:' + SESSION) as { items: unknown[] }).items.length).toBe(1) // the left session is kept as it was
})

test('after /clear the tool statuses are published again', async ($, on) => {
  const { clock, calls, states } = world(on, { isolateState: true })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  current.id = 'sess-2'
  await $.session.append(prompt('hello'))
  const tools = states.get('sess-2|artifact-tracking|tools|')?.value as { gh: { available: boolean | null } } | undefined
  expect(tools?.gh.available).toBe(true)
})

test('an ssh host alias is not kept as the session repo: gh resolves it and #N merges with the URL form', async ($, on) => {
  const { clock, store, calls } = world(on, {
    remote: 'git@github-work:acme/web.git',
    badHosts: ['github-work'],
    repoView: '{"nameWithOwner":"acme/web","url":"https://github.com/acme/web"}',
  })
  await $.session.append(prompt('check #5'))
  await $.session.append(response('Fixed https://github.com/acme/web/issues/5 already.'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await clock.advance(LIMITS.flushMs + 10)
  await sleep(20)
  expect((store.get('s:' + SESSION) as { items: unknown[] }).items.length).toBe(1)
  expect((await track($)).text).toContain('Web five')
})

test('session.start does not wait for the check of a non-github host', async ($, on) => {
  world(on, { remote: 'git@ghe.corp:acme/web.git', authMs: 400, seed: { index: [SESSION], ['s:' + SESSION]: { items: [KEPT] } } })
  const t0 = Date.now()
  await $.session.start(START)
  expect(Date.now() - t0).toBeLessThan(250)
  expect((await track($)).text).toContain('Kept page')
})

test('session.start: bare #N from the transcript is resolved once the repo is known', async ($, on) => {
  const { clock, calls } = world(on, { messages: [{ role: 'user', text: 'please look at #5', toolUses: [] }] })
  await $.session.start(START)
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  expect((await track($)).text).toContain('Web five')
})

test('session.start restores even when command.register is refused', async ($, on) => {
  world(on, { denyRegister: true, seed: { index: [SESSION], ['s:' + SESSION]: { items: [KEPT] } } })
  await $.session.start(START)
  expect((await track($)).text).toContain('Kept page')
})

test('session.start restores a stored copy although the index lost its id', async ($, on) => {
  world(on, { seed: { index: ['other'], ['s:' + SESSION]: { items: [KEPT] } } })
  await $.session.start(START)
  expect((await track($)).text).toContain('Kept page')
})

test('after a reload an open pane gets its tick back at session.start', async ($, on) => {
  const { clock, calls } = world(on, { ghSilent: true, panes: ['track'] })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const before = graphqlCalls(calls).length
  await $.session.start(START)
  await clock.advance(LIMITS.tickMs + 10)
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(before + 1)
})

test('one refused state write does not stop capture for the rest of the session', async ($, on) => {
  const { clock, calls } = world(on, { isolateState: true, denyItemWrites: 1 })
  await $.session.append(prompt('check #5'))
  await $.session.append(prompt('and #9'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const text = (await track($)).text ?? ''
  expect(text).toContain('Web nine')
  expect(text).not.toContain('could not run')
})

test('a refused flush timer does not stop the store mirror for good', async ($, on) => {
  const { clock, store, calls } = world(on, { refuseAfter: LIMITS.flushMs })
  await $.session.append(response('https://one.example/')) // the engine refuses its flush timer
  await clock.advance(LIMITS.flushMs * 3 + 10) // long overdue now
  await quiet(calls)
  await $.session.append(response('https://two.example/'))
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  await sleep(20)
  expect((store.get('s:' + SESSION) as { items: unknown[] } | undefined)?.items.length).toBe(2)
})

test('/track refresh during a run in flight waits for it and prints the refreshed list', async ($, on) => {
  const { clock, calls } = world(on, { ghDelayMs: 150 })
  await $.session.append(prompt('check #5'))
  await clock.advance(LIMITS.captureDebounceMs + 10) // the capture run starts; its gh call takes 150 ms
  expect(graphqlCalls(calls).length).toBe(1) // the capture run is in flight
  const text = (await track($, 'refresh')).text ?? ''
  expect(graphqlCalls(calls).length).toBe(2) // the forced run ran before the command printed
  expect(text).toContain('Web five')
  await quiet(calls)
})

test('the transcript backfill skips system reminders and other meta wrappers', async ($, on) => {
  world(on, {
    messages: [
      { role: 'user', text: '<system-reminder>see https://meta.example/m and #12</system-reminder>', toolUses: [] },
      { role: 'user', text: 'plain https://plain.example/p', toolUses: [] },
    ],
  })
  await $.session.start(START)
  const text = (await track($)).text ?? ''
  expect(text).toContain('plain.example')
  expect(text).not.toContain('meta.example')
  expect(text).not.toContain('#12')
})

// ---------------------------------------------------------------- pane and band

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane: rows are drawn, the Jira fold button hides the children (${surface})`, async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.append(prompt('Look at #5 and https://acme.atlassian.net/browse/ISS-1'))
    await clock.advance(LIMITS.captureDebounceMs + 10)
    await quiet(calls)
    await track($)
    await quiet(calls)
    const ui = await $.ui.mount({ ...PANE, surface } as never) as Awaited<ReturnType<Engine['ui']['mount']>> & {
      find(q: unknown): Promise<unknown>
      press(q: unknown): Promise<void>
      unmount(): Promise<void>
    }
    expect(await ui.find({ text: 'ISS-1' })).toBeDefined()
    expect(await ui.find({ text: 'Web five' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(await ui.find({ text: 'PROJ-201' })).toBeDefined()
    await ui.press({ key: 'fold-jira:acme.atlassian.net/ISS-1' })
    expect(await ui.find({ text: 'PROJ-201' })).toBeUndefined()
    expect(await ui.find({ text: 'ISS-1' })).toBeDefined()
    await ui.press({ key: 'fold-jira:acme.atlassian.net/ISS-1' })
    expect(await ui.find({ text: 'PROJ-201' })).toBeDefined()
    await ui.unmount()
  })
}

test('pane: the Refresh button asks the coordinator for a manual refresh', async ($, on) => {
  const { clock, calls } = world(on, { ghAuthFails: 1 })
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  await track($)
  expect(graphqlCalls(calls).length).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never) as unknown as {
    press(q: unknown): Promise<void>
    unmount(): Promise<void>
  }
  await ui.press({ key: 'refresh' })
  await quiet(calls)
  expect(graphqlCalls(calls).length).toBe(2)
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band: shows the counts and keeps what the engine draws (${surface})`, async ($, on) => {
    const { clock, calls } = world(on)
    // Stands for the engine's own band, which the hook returns inside its Box as next(e).
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
    await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-1'))
    await clock.advance(LIMITS.captureDebounceMs + 10)
    await quiet(calls)
    const ui = await $.ui.mount({ ...BAND, surface } as never) as unknown as {
      find(q: unknown): Promise<unknown>
      unmount(): Promise<void>
    }
    expect(await ui.find({ text: 'Jira 1' })).toBeDefined()
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  })
}

test('band: with nothing tracked the hook yields to the engine', async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never) as unknown as {
    find(q: unknown): Promise<unknown>
    unmount(): Promise<void>
  }
  expect(await ui.find({ text: 'tracking' })).toBeUndefined()
  expect(await ui.find({ text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('band: while a survey holds the band the hook yields to the engine', async ($, on) => {
  const { clock, calls } = world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.session.append(prompt('see https://acme.atlassian.net/browse/ISS-1'))
  await clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(calls)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' } as never) as unknown as {
    find(q: unknown): Promise<unknown>
    unmount(): Promise<void>
  }
  expect(await ui.find({ text: 'Jira 1' })).toBeUndefined()
  expect(await ui.find({ text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

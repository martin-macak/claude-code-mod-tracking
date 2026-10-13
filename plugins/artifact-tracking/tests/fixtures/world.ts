// The kit world shared by register.test.tsx and auto-wiring.test.tsx: stubs for the engine nouns the mod calls,
// and the row builders. Moved out of register.test.tsx with no change to any case (spec 13.2).
// The kit does not reset `$.state` on a new session id. A test that needs it passes `isolateState`.

import type { On, SessionAppendInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { mock } from 'claude-code/testing'
import * as acliFx from './acli'
import * as ghFx from './gh'
import { discoveryData } from './gh-discovery'
import { NOT_A_REPO_STDERR } from './git'

export const SESSION = 'sess-1'
/** The session id the stub answers. A test sets it to what `/clear` would do. */
/** The session id the stub answers, and whether a read of the `items` state fails (needs `isolateState`). */
export const current = { id: SESSION, failItemsRead: false }

// The hooks runtime has timers; tsc here has no DOM or node types.
declare function setTimeout(fn: () => void, ms: number): unknown
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Res = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
export const res = (stdout = '', exitCode = 0, stderr = ''): Res => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// ---------------------------------------------------------------- fake gh and acli

const SAMPLE = (
  JSON.parse(ghFx.BATCH_SAMPLE_OUTPUT) as { data: Record<string, { issueOrPullRequest: Record<string, unknown> }> }
).data
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

export type Opts = {
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
  /** The first `clock.every` period with this delay is refused: the interval ends for good (spec A1). */
  refuseEvery?: number
  /** Writes of the `auto` atom are refused. Needs `isolateState`. */
  denyAutoWrites?: boolean
}

/** Stubs for the engine nouns the mod calls. Register before the first call on `$`. */
export function world(on: On, opts: Opts = {}) {
  // `mock.clock` owns the `clock.after` handler. To refuse one call, wrap that handler as it registers.
  let refused = false
  let refusedEvery = false
  const clockOn = ((name: string, ...rest: unknown[]) => {
    const h = rest[rest.length - 1] as (...a: unknown[]) => unknown
    const byAfter = name === 'clock.after' && opts.refuseAfter !== undefined
    const byEvery = name === 'clock.every' && opts.refuseEvery !== undefined
    if (!byAfter && !byEvery) return (on as (...a: unknown[]) => unknown)(name, ...rest)
    return (on as (...a: unknown[]) => unknown)(name, ...rest.slice(0, -1), (...a: unknown[]) => {
      const ms = (a[1] as { ms: number }).ms
      if (byAfter && !refused && ms === opts.refuseAfter) {
        refused = true
        return { deny: 'refused' }
      }
      if (byEvery && !refusedEvery && ms === opts.refuseEvery) {
        refusedEvery = true
        return { deny: 'refused' }
      }
      return h(...a)
    })
  }) as unknown as On
  const clock = mock.clock(clockOn)
  const store = new Map<string, unknown>(Object.entries(opts.seed ?? {}))
  const fake = {
    /** `git rev-parse --show-toplevel` answers this when `isRepo`, else exit 128 (the default: no repo). */
    isRepo: false,
    toplevel: '/work',
    /** `git worktree list --porcelain`. */
    porcelain: '',
    /** `$.session.cwd()`. */
    cwd: '/work',
    /** `$.agent.list()`. */
    agents: [] as { id: string; status: string; description: string; type: string; teammateId?: string }[],
    /** The id the `agent.spawn` stub answers. */
    spawnId: 'agent-1',
    /** Answers for process probes (docker, tmux, screen, ps). Return undefined to fall through. */
    run: undefined as ((argv: string[]) => Res | undefined) | undefined,
    /** Tool results by tool name. */
    tools: {} as Record<string, unknown>,
    toolRuns: {} as Record<string, number>,
    /** Discovery nodes by `head:<branch>` or `base:<branch>`. */
    nodes: {} as Record<string, unknown[]>,
    discoveryMode: 'ok' as 'ok' | 'transport' | 'query-error' | 'auth',
    /** When set, a discovery call waits for it. */
    discoveryHold: undefined as Promise<void> | undefined,
    storeSets: 0,
    /** `$.state` writes by atom key. Counted when `isolateState` is on. */
    stateSets: {} as Record<string, number>,
  }
  const calls: string[][] = []
  const state = { ghAuthFails: opts.ghAuthFails ?? 0 }
  const registered: { name: string; argumentHint?: string }[] = []
  const opened: unknown[] = []

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    fake.storeSets++
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  current.id = SESSION
  current.failItemsRead = false
  on('session.id', () => ({ value: current.id }))
  on('session.messages', () => ({ value: (opts.messages ?? []) as never }))
  on('session.repo', () => ({
    value:
      opts.remote === null
        ? null
        : { root: '/r', remote: opts.remote ?? 'git@github.com:acme/web.git', internal: false, name: null },
  }))
  on('command.register', (_$, e) => {
    if (opts.denyRegister) return { deny: 'refused' }
    registered.push({ name: e.name, argumentHint: e.argumentHint })
    return { value: { command: e.name } }
  })
  if (opts.panes) {
    on('ui.panes', () => ({
      value: opts.panes!.map(id => ({ id, title: id, isShown: true, isFocused: false })) as never,
    }))
  }
  // The real engine resets `$.state` on /clear. Here a state lives under the session id the stub answers.
  const states = new Map<string, { value: unknown; version: number }>()
  let itemWrites = 0
  if (opts.isolateState) {
    const at = (e: { plugin: string; key: string; id?: string }) => `${current.id}|${e.plugin}|${e.key}|${e.id ?? ''}`
    on('state.get', (_$, e) => {
      if (current.failItemsRead && e.key === 'items') return { deny: 'state read failed' }
      const s = states.get(at(e))
      return { value: { value: s?.value, version: s?.version ?? 0 } as never }
    })
    on('state.set', (_$, e) => {
      fake.stateSets[e.key] = (fake.stateSets[e.key] ?? 0) + 1
      if (e.key === 'auto' && opts.denyAutoWrites) return { deny: 'refused' }
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

  on('session.cwd', () => ({ value: fake.cwd }))
  on('agent.list', () => ({ value: fake.agents as never }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'm', agentId: fake.spawnId }))
  on('tool.call', (_$, e) => {
    const tool = (e as { tool: string }).tool
    fake.toolRuns[tool] = (fake.toolRuns[tool] ?? 0) + 1
    return { result: fake.tools[tool] as never }
  })

  const discoveryReply = (query: string): Res => {
    if (fake.discoveryMode === 'transport') return res('<html>', 1, 'gateway')
    if (fake.discoveryMode === 'query-error') return res(JSON.stringify({ errors: [{ message: 'Field x' }] }), 1)
    if (fake.discoveryMode === 'auth') return res('', 4, ghFx.AUTH_UNAUTH_STDERR)
    const data: Record<string, unknown[]> = {}
    for (const m of query.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
      data[m[1]!] = fake.nodes[`${m[3]}:${JSON.parse(m[4]!) as string}`] ?? []
    return res(JSON.stringify({ data: discoveryData(data, 'main') }))
  }

  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const [tool, a1, a2, a3, a4] = argv
    if (tool === 'acli' && a1 === '--version' && opts.acliProbeMs) await sleep(opts.acliProbeMs)
    if (opts.missing?.includes(tool!)) return { deny: 'ENOENT: Executable not found in $PATH' }
    const custom = fake.run?.(argv)
    if (custom) return { value: custom }
    if (a1 === '--version')
      return { value: res(tool === 'gh' ? 'gh version 2.102.0 (2026-09-30)' : 'acli version 1.3.19-stable') }
    if (tool === 'gh' && a1 === 'api' && a2 === 'graphql') {
      if (opts.ghDelayMs) await sleep(opts.ghDelayMs)
      const query = argv.find(x => x.startsWith('query='))?.slice('query='.length) ?? ''
      if (query.includes('pullRequests(')) {
        if (fake.discoveryHold) await fake.discoveryHold
        return { value: discoveryReply(query) }
      }
      return { value: graphql(query) }
    }
    if (tool === 'git' && a1 === 'rev-parse')
      return { value: fake.isRepo ? res(fake.toplevel + '\n') : res('', 128, NOT_A_REPO_STDERR) }
    if (tool === 'git' && a1 === 'worktree') return { value: res(fake.porcelain) }
    if (tool === 'gh' && a1 === 'auth') {
      if (opts.authMs) await sleep(opts.authMs)
      return { value: opts.badHosts?.includes(a4!) ? res('', 1, ghFx.GHE_AUTH_STATUS_STDERR) : res('Logged in') }
    }
    if (tool === 'gh' && a1 === 'repo') return { value: res(opts.repoView ?? ghFx.REPO_RESOLUTION_STDOUT) }
    if (tool === 'acli' && a2 === 'auth') return { value: res(ACLI_AUTH) }
    if (tool === 'acli' && a3 === 'view') return { value: res(withKey(acliFx.TASK_VIEW_JSON, a4!)) }
    return { value: res('', 1, 'unexpected call: ' + argv.join(' ')) }
  })

  return { clock, store, calls, state, registered, opened, states, fake }
}

export const graphqlCalls = (calls: string[][]) => calls.filter(c => c[0] === 'gh' && c[1] === 'api')
export const viewCalls = (calls: string[][]) => calls.filter(c => c[0] === 'acli' && c[3] === 'view')

/** Waits until no new process.run call has come for a while: the refresh and its save are done. */
export async function quiet(calls: unknown[]): Promise<void> {
  let stable = 0
  let last = -1
  for (let i = 0; i < 200 && stable < 4; i++) {
    await sleep(10)
    stable = calls.length === last ? stable + 1 : 0
    last = calls.length
  }
}

export const track = ($: Engine, args = '') =>
  $.command.run({
    command: 'track',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

// ---------------------------------------------------------------- rows

let seq = 0
const uuid = () => 'u' + ++seq

export const prompt = (
  text: string,
  kind = 'composer',
  extra: { isMeta?: true; agentId?: string } = {},
): SessionAppendInput => ({
  door: 'prompt',
  origin: { kind } as never,
  uuid: uuid(),
  agentId: extra.agentId,
  message: { type: 'user', role: 'user', isMeta: extra.isMeta, content: [{ type: 'text', text }] },
})

export const commandRow = (text: string, kind: 'composer' | 'engine'): SessionAppendInput =>
  ({
    door: 'command',
    origin: { kind },
    uuid: uuid(),
    message: { type: kind === 'engine' ? 'system' : 'user', role: 'user', content: [{ type: 'text', text }] },
  }) as SessionAppendInput

export const response = (text: string): SessionAppendInput => ({
  door: 'response',
  origin: { kind: 'model', model: 'm' },
  uuid: uuid(),
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
})

export const toolResult = (content: unknown): SessionAppendInput => ({
  door: 'tool-result',
  origin: { kind: 'tool', tool: 'Bash' },
  uuid: uuid(),
  message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content }] },
})

export const START = { cwd: '/work', surface: null, isInteractive: false } as const

export const PANE = {
  plugin: 'artifact-tracking',
  component: 'Pane',
  requestId: 'track',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'Tracking',
    isFocused: false,
    bodyColumns: 96,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 28 },
    view: {},
  },
} as const

export const BAND = {
  plugin: 'artifact-tracking',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 90,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

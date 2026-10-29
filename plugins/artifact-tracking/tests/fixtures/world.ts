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
/**
 * The session id the stub answers, whether a read of the `items` state fails, and the id of a tracker slot (`trackers` family)
 * whose read fails (both need `isolateState`).
 */
export const current = { id: SESSION, failItemsRead: false, failSlot: undefined as string | undefined }

// The hooks runtime has timers; tsc here has no DOM or node types.
declare function setTimeout(fn: () => void, ms: number): unknown
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Polls until the condition holds, for work a hook starts and does not return (a tick, a lookup). Throws after `ms`.
 * The condition may be async: a test that draws again before it looks says so there.
 * The limit is a hang guard, not a speed limit: a busy machine takes seconds for what takes milliseconds on a quiet one
 * (issue #104). 20 s stays inside the 30 s of `test` (fixtures/kit.ts), so the message names the wait, not the kit.
 */
export async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

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
  /**
   * What `$.session.surfaces()` answers (the hook-side read of the surfaces the session draws on). Default `[]`: nothing draws,
   * as under `claude -p`, so `/track qa` answers its whole text. A test of the screen path passes `['terminal']`. The kit rejects
   * the read when no hook answers it, which the mod counts as "a surface draws" (issue #246).
   */
  surfaces?: readonly string[]
  /** Files on the stub disk the config file lives on: path to text. */
  disk?: Record<string, string>
  /** Refuse one fs op of the stub disk with this message (`$.fs.read`, `$.fs.write`, `$.fs.exists`, `$.fs.stat`). */
  denyFs?: Partial<Record<'read' | 'write' | 'exists' | 'stat', string>>
  /**
   * The text of the mod's manifest: what `$.fs.read` answers for `<plugin root>/.claude-plugin/plugin.json`. The kit
   * cannot read the real disk, and the test body cannot see `$.plugin.root`, so the stub matches the file name. Absent:
   * the file is missing (ENOENT), as for a mod whose manifest cannot be read.
   */
  manifest?: string
}

/** The tail of the manifest path: the stub of `fs.read` matches it, whatever the plugin root is. */
export const MANIFEST_TAIL = '/.claude-plugin/plugin.json'

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
  // The stub disk (L4): the config file lives here. A write sets the text and moves the mtime, as a real save does.
  const disk = new Map<string, string>(Object.entries(opts.disk ?? {}))
  const mtimes = new Map<string, number>()
  let mtimeClock = 1_000
  const touch = (path: string) => void mtimes.set(path, ++mtimeClock)
  for (const path of disk.keys()) touch(path)
  const fsCalls: string[] = []
  const fsWrites: { path: string; text: string }[] = []
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
    run: undefined as ((argv: string[]) => Res | undefined | Promise<Res | undefined>) | undefined,
    /** Tool results by tool name. */
    tools: {} as Record<string, unknown>,
    /** Whole tool.call replies by tool name, for shapes `{ result }` cannot carry: `{ isError, result }`, `{ deny }`. */
    toolReplies: {} as Record<string, unknown>,
    /** Tools whose call throws this message, as a tool that fails before it answers. */
    toolThrows: {} as Record<string, string>,
    /** Files `$.fs.stat` finds: path → where it lands. Any other path rejects ENOENT. */
    files: {} as Record<string, string>,
    /** The stub disk of the config file: path to text. `fs.stat` answers `files` first, then this. */
    disk,
    /** The successful `$.fs.write` calls, in order. */
    fsWrites,
    /** Every `$.fs` call, denied ones too: `'<op> <path>'`. */
    fsCalls,
    /** Every `$.ui.log` line, in order. */
    logs: [] as { text: string; to: string }[],
    /** Sets the text of a disk file and moves its mtime, as an editor save does. */
    editDisk(path: string, text: string): void {
      disk.set(path, text)
      touch(path)
    },
    /** The whole `tool.call` answer by tool name, returned as it stands (`{ deny }`, `{ isError: true, ... }`). */
    toolAnswers: {} as Record<string, unknown>,
    toolRuns: {} as Record<string, number>,
    /** The input of every `tool.call`, by tool name, in order: what the engine would have run. */
    toolInputs: {} as Record<string, unknown[]>,
    /** Discovery nodes by `head:<branch>` or `base:<branch>`. */
    nodes: {} as Record<string, unknown[]>,
    discoveryMode: 'ok' as 'ok' | 'transport' | 'query-error' | 'auth',
    /** When set, a discovery call waits for it. */
    discoveryHold: undefined as Promise<void> | undefined,
    /** When set, `gh auth status` answers once it settles. A test holds it to check an order, not a time. */
    authHold: undefined as Promise<void> | undefined,
    /** When set, every `gh api graphql` call waits for it. Same use as `authHold`. */
    ghHold: undefined as Promise<void> | undefined,
    storeSets: 0,
    /** `$.state` writes by member: an atom's key, a family member's id. Counted when `isolateState` is on. */
    stateSets: {} as Record<string, number>,
  }
  const calls: string[][] = []
  const state = { ghAuthFails: opts.ghAuthFails ?? 0 }
  const registered: { name: string; argumentHint?: string }[] = []
  const opened: unknown[] = []
  /** One entry per `ui.panes` read. */
  const paneReads: true[] = []

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
  current.failSlot = undefined
  on('session.id', () => ({ value: current.id }))
  on('session.messages', () => ({ value: (opts.messages ?? []) as never }))
  on('session.surfaces', () => ({ value: (opts.surfaces ?? []) as never }))
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
  // The real engine resets `$.state` on /clear. Here a state lives under the session id the stub answers.
  const states = new Map<string, { value: unknown; version: number }>()
  let itemWrites = 0
  if (opts.isolateState) {
    const at = (e: { plugin: string; key: string; id?: string }) => `${current.id}|${e.plugin}|${e.key}|${e.id ?? ''}`
    on('state.get', (_$, e) => {
      if (current.failItemsRead && e.key === 'items') return { deny: 'state read failed' }
      if (current.failSlot !== undefined && e.key === 'trackers' && e.id === current.failSlot)
        return { deny: 'state read failed' }
      const s = states.get(at(e))
      return { value: { value: s?.value, version: s?.version ?? 0 } as never }
    })
    on('state.set', (_$, e) => {
      // A family member counts under its id (`repos`, `auto`), an atom under its key.
      const member = (e as { id?: string }).id ?? e.key
      fake.stateSets[member] = (fake.stateSets[member] ?? 0) + 1
      if (member === 'auto' && opts.denyAutoWrites) return { deny: 'refused' }
      if (e.key === 'items' && itemWrites++ < (opts.denyItemWrites ?? 0)) return { deny: 'refused' }
      const cur = states.get(at(e))
      const version = cur?.version ?? 0
      if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
      // `e.value` is a recursive Json union since the `trackers` family: tsc gives up on it, so read it as unknown.
      const written = (e as unknown as { value?: unknown }).value
      states.set(at(e), { value: JSON.parse(JSON.stringify(written ?? null)), version: version + 1 })
      return { value: { isSet: true, version: version + 1 } }
    })
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  // The engine moves the ring. The kit has nothing beneath the plugins for `ui.focus`, so answer it here.
  on('ui.focus', () => ({}))
  // The lifecycle layer reads these. `session.end` echoes the id, like core; `ui.panes` lists the panes the engine
  // keeps across a hot reload (none unless a test passes `panes`).
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('ui.panes', () => {
    paneReads.push(true)
    return { value: (opts.panes ?? []).map(id => ({ id, title: id, isShown: true, isFocused: false })) as never }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    fake.logs.push({ text: e.text, to: String(e.to) })
    return { value: undefined }
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
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'm', agentId: fake.spawnId }))
  on('tool.call', (_$, e) => {
    const tool = (e as { tool: string }).tool
    fake.toolRuns[tool] = (fake.toolRuns[tool] ?? 0) + 1
    fake.toolInputs[tool] = [...(fake.toolInputs[tool] ?? []), e]
    if (tool in fake.toolThrows) throw new Error(fake.toolThrows[tool])
    if (tool in fake.toolReplies) return fake.toolReplies[tool] as never
    if (Object.hasOwn(fake.toolAnswers, tool)) return fake.toolAnswers[tool] as never
    return { result: fake.tools[tool] as never }
  })
  // One stub per fs op, always registered. A deny switch answers first. Each returns `{ value }` or `{ deny }`.
  const denied = (op: 'read' | 'write' | 'exists' | 'stat', path: string) => {
    fsCalls.push(`${op} ${path}`)
    const message = opts.denyFs?.[op]
    return message === undefined ? undefined : { deny: message }
  }
  const missing = (op: string, path: string) => ({ deny: `ENOENT: no such file or directory, ${op} '${path}'` })
  on('fs.stat', (_$, e) => {
    const no = denied('stat', e.path)
    if (no) return no
    const real = fake.files[e.path]
    if (real !== undefined)
      return {
        value: { kind: 'file', size: 1, mtimeMs: 0, isLink: real !== e.path, ...(e.resolve ? { realPath: real } : {}) },
      }
    const text = disk.get(e.path)
    if (text === undefined) return missing('stat', e.path)
    return { value: { kind: 'file', size: text.length, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const no = denied('read', e.path)
    if (no) return no
    if (opts.manifest !== undefined && e.path.endsWith(MANIFEST_TAIL)) return { value: opts.manifest }
    const text = disk.get(e.path)
    return text === undefined ? missing('open', e.path) : { value: text }
  })
  on('fs.write', (_$, e) => {
    const no = denied('write', e.path)
    if (no) return no
    disk.set(e.path, e.text)
    touch(e.path)
    fsWrites.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => {
    const no = denied('exists', e.path)
    if (no) return no
    return { value: disk.has(e.path) || e.path in fake.files }
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
    const custom = await fake.run?.(argv)
    if (custom) return { value: custom }
    if (a1 === '--version')
      return { value: res(tool === 'gh' ? 'gh version 2.102.0 (2026-09-30)' : 'acli version 1.3.19-stable') }
    if (tool === 'gh' && a1 === 'api' && a2 === 'graphql') {
      if (opts.ghDelayMs) await sleep(opts.ghDelayMs)
      if (fake.ghHold) await fake.ghHold
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
      if (fake.authHold) await fake.authHold
      // `gh auth status --hostname <h> --json hosts`, as gh 2.102.0 answers: exit 0, the account of the host, or none.
      return {
        value: opts.badHosts?.includes(a4!)
          ? res(ghFx.AUTH_STATUS_JSON_NO_LOGIN, 0, ghFx.AUTH_STATUS_NO_LOGIN_NOTICE)
          : res(ghFx.authStatusJson(a4!)),
      }
    }
    if (tool === 'gh' && a1 === 'repo') return { value: res(opts.repoView ?? ghFx.REPO_RESOLUTION_STDOUT) }
    if (tool === 'acli' && a2 === 'auth') return { value: res(ACLI_AUTH) }
    if (tool === 'acli' && a3 === 'view') return { value: res(withKey(acliFx.TASK_VIEW_JSON, a4!)) }
    return { value: res('', 1, 'unexpected call: ' + argv.join(' ')) }
  })

  return { clock, store, calls, state, registered, opened, paneReads, states, fake }
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

// ---------------------------------------------------------------- /clear and /resume

/**
 * Plays the engine order of a live `/clear` or `/resume`: `session.end` sees the leaving id, then the id changes.
 * A `/clear` then appends its command row, which is the first hook of the new session. `/resume` appends none.
 * Pass `{ row: false }` for a `/clear` whose row the test must not send (the tick has to find the switch).
 * `w` is the world, or any object that holds its `calls`.
 */
export async function clearSession(
  $: Engine,
  w: { calls: unknown[] },
  nextId: string,
  reason: 'clear' | 'resume',
  opts: { row?: boolean } = {},
): Promise<void> {
  const leaving = current.id
  await $.session.end({
    reason,
    sessionId: leaving,
    ...(reason === 'resume' ? { resume: { id: leaving } } : {}),
  } as never)
  current.id = nextId
  if (opts.row ?? reason === 'clear') {
    // A live /clear appends this row 11 ms after session.end; /resume appends none
    // (claude-code-mods KB, concepts/lifecycle.md, the "/resume and /branch" table).
    await $.session.append({
      door: 'command',
      origin: { kind: 'unclassified' },
      uuid: uuid(),
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] },
    } as never)
    await quiet(w.calls)
  }
}

// ---------------------------------------------------------------- file tool results (issue #28, observed shapes)

export const writeCreated = (filePath: string) => ({
  type: 'create',
  filePath,
  content: '# x',
  structuredPatch: [],
  originalFile: null,
  userModified: false,
})
export const writeUpdated = (filePath: string) => ({ ...writeCreated(filePath), type: 'update', originalFile: '# x' })
export const editDone = (filePath: string) => ({
  filePath,
  oldString: 'a',
  newString: 'b',
  originalFile: 'a',
  structuredPatch: [],
  userModified: false,
  replaceAll: false,
})
export const readDone = (filePath: string) => ({
  type: 'text',
  file: { filePath, content: '# x', numLines: 1, startLine: 1, totalLines: 1 },
})

/** The answer of a second Read of a file that did not change (issue #245). */
export const readUnchanged = (filePath: string) => ({ type: 'file_unchanged', file: { filePath } })

/** Runs one Write, Edit or Read through the mod with `result` as the tool's answer. Resolves to the reply. */
export function fileTool(
  $: Engine,
  fake: { tools: Record<string, unknown> },
  tool: 'Write' | 'Edit' | 'Read',
  result: { filePath?: string; file?: { filePath: string } },
): Promise<unknown> {
  fake.tools[tool] = result
  const file_path = result.filePath ?? result.file?.filePath
  return $.tool.call({ tool, file_path } as never)
}

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

// fakePorts: a full in-memory `Ports` for Node unit tests of the lifecycle collaborators. No engine, no `$`.
// It imports no `node:` module, so the kit can load it too. A test reads and changes the world it returns:
// seed `store`, `files`, `env`; read `storeSets`, `calls`, `logs`; move the clock with `clock.advance`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.4. Plan: L3 Task 2.

import type { Json, StoredItem } from '../../core/interfaces/items'
import type {
  AgentInfo,
  AtomPort,
  EnvName,
  FsStat,
  PaneInfo,
  Ports,
  RepoRemote,
  RunResult,
  SessionRow,
  Timer,
} from '../../core/interfaces/ports'
import type { ToolStatus } from '../../types'

export type FakeOpts = {
  /** Engine time at the start. Default 0. */
  now?: number
  /** The session id, cwd, repo and transcript the `session` port answers. */
  session?: { id?: string; cwd?: string; repo?: RepoRemote | null; messages?: SessionRow[] }
  /** Seeds the store. */
  store?: Record<string, Json>
  /** Seeds the files: path to text. */
  files?: Record<string, string>
  env?: Record<string, string>
  settings?: Json
  agents?: AgentInfo[]
  panes?: PaneInfo[]
}

export type FakeWorld = {
  ports: Ports
  /** `now` is engine time. `wall()` answers it too. `advance` fires due timers in time order and awaits each callback. */
  clock: {
    now: number
    advance(ms: number): Promise<void>
    /** The next due `after` or `every` period of `ms` is refused: an `after` never fires, an `every` ends (E18). */
    refuse(kind: 'after' | 'every', ms: number): void
  }
  store: Map<string, Json>
  /** Calls of `store.set`. */
  storeSets: number
  /** The `$.state` data by member: `items`, `tools`, `ui`, and one entry per slot id. */
  state: Map<string, Json>
  /** Writes by member, like the kit world counts them. */
  stateSets: Record<string, number>
  /** The argv of every `run` call. */
  calls: string[][]
  /** Answers a `run` call. undefined falls through to the default: exit 1, "unexpected call". */
  run?: (argv: string[]) => RunResult | undefined | Promise<RunResult | undefined>
  files: Record<string, string>
  env: Record<string, string>
  settings?: Json
  session: { id: string; cwd: string; repo: RepoRemote | null; messages: SessionRow[] }
  agents: AgentInfo[]
  /** `placed` is what `ui.open` answers: false when the terminal is too narrow for the pane. */
  ui: { opened: number; placed: boolean; focused: string[]; invalidated: number; toasts: string[]; panes: PaneInfo[] }
  logs: string[]
}

type Pending = {
  seq: number
  kind: 'after' | 'every'
  ms: number
  at: number
  fn: () => void
  cancelled: boolean
}

const clone = <T extends Json | undefined>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

export function fakePorts(o: FakeOpts = {}): FakeWorld {
  let timers: Pending[] = []
  let seq = 0
  const refusals: { kind: 'after' | 'every'; ms: number }[] = []
  const mtimes = new Map<string, number>()

  const arm = (kind: 'after' | 'every', ms: number, fn: () => void): Timer => {
    const t: Pending = {
      seq: seq++,
      kind,
      ms: Math.max(1, ms),
      at: world.clock.now + Math.max(0, ms),
      fn,
      cancelled: false,
    }
    timers.push(t)
    return {
      cancel() {
        t.cancelled = true
      },
    }
  }

  const atom = <T>(key: string, empty: () => T): AtomPort<T> => ({
    async get() {
      return clone((world.state.get(key) ?? empty()) as T & Json)
    },
    async update(fn) {
      const next = fn(clone((world.state.get(key) ?? empty()) as T & Json))
      world.state.set(key, clone(next as T & Json))
      world.stateSets[key] = (world.stateSets[key] ?? 0) + 1
      return clone(next as T & Json)
    },
  })

  const ports: Ports = {
    clock: {
      now: async () => world.clock.now,
      wall: () => world.clock.now,
      after: (ms, fn) => arm('after', ms, fn),
      every: (ms, fn) => arm('every', ms, fn),
    },
    run: async argv => {
      world.calls.push([...argv])
      const custom = await world.run?.([...argv])
      return custom ?? { exitCode: 1, stdout: '', stderr: `unexpected call: ${argv.join(' ')}` }
    },
    fs: {
      async read(path) {
        const text = world.files[path]
        if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return text
      },
      async write(path, text) {
        world.files[path] = text
        mtimes.set(path, world.clock.now)
      },
      async exists(path) {
        return world.files[path] !== undefined
      },
      async stat(path, opts) {
        const text = world.files[path]
        if (text === undefined) return null
        const stat: FsStat = { kind: 'file', size: text.length, mtimeMs: mtimes.get(path) ?? 0, isLink: false }
        return opts?.resolve ? { ...stat, realPath: path } : stat
      },
    },
    env: { get: async (name: EnvName) => world.env[name] },
    settings: { read: async () => clone(world.settings ?? {}) },
    store: {
      async get(key) {
        return clone(world.store.get(key))
      },
      async set(key, value) {
        world.storeSets++
        world.store.set(key, clone(value))
      },
      async delete(key) {
        world.store.delete(key)
      },
      async keys() {
        return [...world.store.keys()]
      },
    },
    session: {
      id: async () => world.session.id,
      cwd: async () => world.session.cwd,
      repo: async () => world.session.repo,
      messages: async () => world.session.messages,
    },
    agents: { list: async () => world.agents },
    state: {
      items: atom<StoredItem[]>('items', () => []),
      tools: atom<Record<string, ToolStatus>>('tools', () => ({})),
      ui: atom<{ folded: string[] }>('ui', () => ({ folded: [] })),
      slot: {
        async get(id) {
          return clone(world.state.get(id))
        },
        async update(id, fn) {
          const next = clone(fn(clone(world.state.get(id))))
          world.state.set(id, next)
          world.stateSets[id] = (world.stateSets[id] ?? 0) + 1
          return clone(next)
        },
      },
    },
    ui: {
      async open() {
        world.ui.opened++
        return world.ui.placed
      },
      async focus(key) {
        world.ui.focused.push(key)
      },
      panes: async () => world.ui.panes,
      invalidate() {
        world.ui.invalidated++
      },
      toast(text) {
        world.ui.toasts.push(text)
      },
    },
    log: line => void world.logs.push(line),
  }

  const world: FakeWorld = {
    ports,
    clock: {
      now: o.now ?? 0,
      async advance(ms) {
        const target = world.clock.now + ms
        for (;;) {
          timers = timers.filter(t => !t.cancelled)
          const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
          if (!due) break
          world.clock.now = Math.max(world.clock.now, due.at)
          // An `every` is armed for its next period before its callback runs, so a callback that cancels it wins.
          if (due.kind === 'every') due.at += due.ms
          else due.cancelled = true
          const refused = refusals.findIndex(r => r.kind === due.kind && r.ms === due.ms)
          if (refused >= 0) {
            refusals.splice(refused, 1)
            due.cancelled = true
            continue
          }
          await due.fn()
        }
        world.clock.now = target
      },
      refuse(kind, ms) {
        refusals.push({ kind, ms })
      },
    },
    store: new Map(Object.entries(o.store ?? {}).map(([k, v]) => [k, clone(v)])),
    storeSets: 0,
    state: new Map(),
    stateSets: {},
    calls: [],
    files: { ...(o.files ?? {}) },
    env: { ...(o.env ?? {}) },
    settings: o.settings,
    session: {
      id: o.session?.id ?? 'sess-1',
      cwd: o.session?.cwd ?? '/work',
      repo: o.session?.repo ?? null,
      messages: o.session?.messages ?? [],
    },
    agents: o.agents ?? [],
    ui: { opened: 0, placed: true, focused: [], invalidated: 0, toasts: [], panes: o.panes ?? [] },
    logs: [],
  }
  return world
}

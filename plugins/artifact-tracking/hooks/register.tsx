// Wiring for the artifact-tracking mod. The only file that touches `$`.
// Capture hooks observe rows. A coordinator refreshes the items with gh and acli. A pane and a band draw them.
// Specs: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md sections 6 to 10, and
// docs/superpowers/specs/2026-10-10-auto-tracking-design.md (the `auto` atom, the tick, the round, the hooks of spec 7).

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { RefreshCoordinator } from '../core/infra/coordinator'
import { GLOBAL_DEFAULTS } from '../core/infra/global-defaults'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ReplayItem } from '../core/interfaces/events'
import type { ItemsHost, Json, StoredItem } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import type { DataSlot } from '../core/interfaces/slots'
import type { FactsPort } from '../core/interfaces/tracker'
import { isRecord } from '../core/lib/json'
import { textOfContent } from '../core/lib/links'
import { buildTrackers } from '../trackers'
import { artifactEvent } from '../trackers/artifact/artifact-tool'
import type { AutoGithub } from '../trackers/auto'
import { autoDismiss } from '../trackers/auto/dismiss-store'
import { emptyAuto } from '../trackers/auto/ledger'
import {
  type FileTouch,
  type IgnoreContext,
  isIgnored,
  mdCandidates,
  normalizePath,
  resolvePath,
  touchFromToolResult,
} from '../trackers/file/files'
import { dropAuto } from '../trackers/github/discovered'
import { GhTool } from '../trackers/github/gh-tool'
import { AcliTool } from '../trackers/jira/acli-tool'
import { renderBand } from '../ux/band'
import { renderSections } from '../ux/pane'
import type {
  AutoState,
  FileActivity,
  FileRecord,
  GitHubDiscoveryApi,
  GitHubRef,
  GitHubTarget,
  ItemRecord,
  Priority,
  ProcessRecord,
  ProcessUiState,
  Ref,
  RepoRecord,
  RepoRef,
  Runner,
  ScanMode,
  Sighting,
  Source,
  ToolStatus,
  UiState,
} from './contracts'
import { AUTO_SOURCES } from './contracts'
import { rowEvent, spawnEvent, toolCallEvent, turnEvent } from './events'
import { artifactOrigin, keyOf } from './model/keys'
import { rowIdOf, setPriority } from './model/priority'
import {
  carryOver,
  hydrate,
  markArtifactDeleted,
  mergeFiles,
  mergeRefs,
  mergeResults,
  recordFromFile,
  rekeyArtifacts,
  resolveBareRefs,
  unionRecords,
} from './model/registry'
import { commandArgs, extractRefs, parseRemote } from './scan/refs'
import { composeBand, composeCommandText, composePane } from './ui/auto-view'
import type { ViewContext } from './ui/view'
import { focusTargets, markKeys } from './ui/view'

// ------------------------------------------------------------------ state

// Working set in $.state (survives hot reload, reset by /clear). Persistence copies it to $.store, one key per session.
// The contract (types/index.d.ts) has four keys. `items`, `tools` and `ui` are atoms. Each tracker's data is one
// member of the `trackers` family (spec 5.13, plan decision D14): `repos`, `processes` and `auto`.
const items = atom({ plugin: 'artifact-tracking', key: 'items' } as const, [] as ItemRecord[])
const IDLE_GH: ToolStatus = { name: 'gh', available: null, loggedIn: null, breaker: 'closed' }
const IDLE_ACLI: ToolStatus = { name: 'acli', available: null, loggedIn: null, breaker: 'closed' }
const tools = atom(
  { plugin: 'artifact-tracking', key: 'tools' } as const,
  { gh: IDLE_GH, acli: IDLE_ACLI } as Record<string, ToolStatus>,
)
const ui = atom({ plugin: 'artifact-tracking', key: 'ui' } as const, { folded: [] } as UiState)

/**
 * One member of the `trackers` family, typed. The family stores Json; the shapes are the records of the contract.
 * `empty` is what a member never written reads as. It runs on every read, so each read of a missing member gets a
 * fresh value.
 * Plain functions, not methods: `claude plugin validate` refuses `$` as an argument of a method call.
 */
async function readSlot<T>($: EngineInterface, id: string, empty: () => T): Promise<T> {
  return ((await portsOf($).state.slot.get(id)) as unknown as T | undefined) ?? empty()
}

const noRows = (): never[] => []

function readRepos($: EngineInterface): Promise<RepoRecord[]> {
  return readSlot<RepoRecord[]>($, 'repos', noRows)
}

function readProcesses($: EngineInterface): Promise<ProcessRecord[]> {
  return readSlot<ProcessRecord[]>($, 'processes', noRows)
}

/** The run: root, proofs, agents, dismiss list and the last snapshot (spec 6.2). Never goes to $.store. */
function readAuto($: EngineInterface): Promise<AutoState> {
  return readSlot<AutoState>($, 'auto', emptyAuto)
}

// ------------------------------------------------------------------ ports

/**
 * The engine as ports (spec 5.4). Built per dispatch, so each `$` call keeps the hook's agent context (E5).
 * Each closure holds a literal `$` call and each state ref is a literal, so `claude plugin validate` lists
 * what the module reads and writes (E4). Only the `trackers` slots and (from the next step) the store use it yet.
 */
function portsOf($: EngineInterface): Ports {
  return {
    clock: {
      now: () => $.clock.now(),
      wall: Date.now,
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    run: (argv, opts) => $.process.run(argv, opts),
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      stat: async (path, opts) => {
        try {
          return await (opts?.resolve ? $.fs.stat(path, { resolve: true }) : $.fs.stat(path))
        } catch {
          return null // any refusal
        }
      },
    },
    env: {
      // One literal call per name: validate lists the names this module reads.
      get: name => {
        switch (name) {
          case 'HOME':
            return $.env.get('HOME')
          case 'XDG_CONFIG_HOME':
            return $.env.get('XDG_CONFIG_HOME')
          case 'CLAUDE_TRACKER_CONFIG_DIR':
            return $.env.get('CLAUDE_TRACKER_CONFIG_DIR')
          case 'CLAUDE_CONFIG_DIR':
            return $.env.get('CLAUDE_CONFIG_DIR')
        }
      },
    },
    settings: { read: async () => (await $.settings.read()) as unknown as Json },
    store: {
      get: async key => (await $.store.get(key)) as Json | undefined,
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    session: {
      id: () => $.session.id(),
      cwd: () => $.session.cwd(),
      repo: async () => {
        const info = await $.session.repo()
        return (info?.remote ? parseRemote(info.remote) : null) ?? null
      },
      messages: () => $.session.messages(),
    },
    agents: {
      list: async () =>
        (await $.agent.list()).map(a => ({
          id: a.id,
          status: a.status,
          ...(a.teammateId !== undefined ? { teammateId: a.teammateId } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.type !== undefined ? { type: a.type } : {}),
        })),
    },
    state: {
      items: {
        get: async () => (await read($, items)) as StoredItem[],
        update: async fn => (await update($, items, cur => fn(cur as StoredItem[]) as ItemRecord[])) as StoredItem[],
      },
      tools: { get: () => read($, tools), update: fn => update($, tools, fn) },
      ui: { get: () => read($, ui), update: fn => update($, ui, fn) },
      slot: {
        get: id => read($, { plugin: 'artifact-tracking', key: 'trackers', id } as const),
        update: (id, fn) => update($, { plugin: 'artifact-tracking', key: 'trackers', id } as const, cur => fn(cur)),
      },
    },
    ui: {
      open: async () =>
        (await $.ui.open({ id: 'track', title: 'Tracking', focus: true, closeOnEscape: true })).isPlaced,
      focus: async key => {
        await $.ui.focus({ requestId: 'track', key })
      },
      panes: () => $.ui.panes(),
      invalidate: () => {
        try {
          $.ui.invalidate('ui.render')
        } catch {
          // A refused redraw changes nothing the next one cannot fix.
        }
      },
      toast: text => $.ui.toast(text),
    },
    log: line => {
      try {
        $.ui.log(line, { to: 'debug' })
      } catch {
        // A log line must never fail a hook.
      }
    },
  }
}

const PANE = 'track'
const USAGE = 'Usage: /track [refresh|clear|prio <ref> <high|normal|low|auto>]'
/** `/track prio` levels: `auto` removes the person's mark. */
const PRIO_WORDS = new Set(['high', 'normal', 'low', 'auto'])
/** D3: the person's own text. Never a machine, a notification or a coordinator. */
const PERSON = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

// Module state. A hot reload loses it. Each part is rebuilt on the next use.
let gh: GhTool | undefined
let acli: AcliTool | undefined
let coordinator: RefreshCoordinator | undefined
/** undefined: not resolved yet. null: this session has no known repo. */
let sessionRepo: RepoRef | null | undefined
let repoTask: Promise<void> | undefined
let githubHosts: string[] = []
/** The session switch, the store and the facts of this load. Built on first use; a hot reload builds a new one. */
let manager: LifecycleManager | undefined
/** The row the priority keys act on. Never stored: a close, a reload or /clear forgets it. */
let focusedRow: string | undefined
/** Element key to row id, for the Buttons of the rows with a prio cell as last drawn (`focusTargets`). */
let focusRows: ReadonlyMap<string, string> = new Map()

// ------------------------------------------------------------------ runtime

/** Builds the tools and the coordinator once. `$` only appears in calls, never as a value. */
function ensureRuntime($: EngineInterface): void {
  if (gh && acli && coordinator) return
  const run: Runner = (argv, init) => $.process.run(argv, init)
  const g = new GhTool(run, Date.now)
  const a = new AcliTool(run, Date.now)
  gh = g
  acli = a
  // Probe without waiting: acli takes about 0.6 s. Until a probe settles, the tool reads as not available.
  void Promise.allSettled([g.probe(), a.probe()]).then(() => publishTools($))
  coordinator = new RefreshCoordinator({
    now: Date.now,
    load: () => read($, items),
    save: async refreshed => {
      const refreshedKeys = new Set(refreshed.map(rec => rec.key))
      const before = await read($, items)
      await setItems($, list => mergeResults(list, refreshed))
      const after = await read($, items)
      const kept = new Set(after.map(rec => rec.key))
      const dropped = before.filter(rec => refreshedKeys.has(rec.key) && !kept.has(rec.key)).map(rec => rec.key)
      if (dropped.length > 0) {
        // Keep discarded keys in this run's dismiss list, so transcript replay does not bring them back on /resume.
        try {
          await autoDismiss(portsOf($).state.slot).add(dropped)
        } catch {
          // The list is already merged; dismissal tracking is best-effort.
        }
      }
    },
    hydrate: rec => hydrate(rec, { gh: g, acli: a }),
    tools: { gh: g, acli: a },
    after: (ms, fn) => $.clock.after(ms, fn),
    onRun: async () => {
      await publishTools($)
      await schedule($)
    },
    onError: () => {
      // The tools record their own failures. A run must not break the session.
    },
  })
}

/** The status as the pane sees it. `lastRunAt` moves on every call and no view shows it, so it is not compared (A22). */
const shown = (x: Record<string, ToolStatus>): string =>
  JSON.stringify([
    { ...x.gh, lastRunAt: undefined },
    { ...x.acli, lastRunAt: undefined },
  ])

/** The two statuses the sections read. A tool the record does not list yet reads as not probed. */
const viewTools = (x: Record<string, ToolStatus>): { gh: ToolStatus; acli: ToolStatus } => ({
  gh: x.gh ?? IDLE_GH,
  acli: x.acli ?? IDLE_ACLI,
})

/**
 * Active Jira site state:
 * - `undefined`: no acli runtime (do not filter Jira refs)
 * - `null`: acli runtime exists, but no active site could be loaded
 * - `<host>`: active Jira site host
 */
async function activeJiraSite(): Promise<string | null | undefined> {
  const a = acli
  if (!a) return undefined
  if (a.activeSite !== undefined) return a.activeSite
  try {
    return await a.loadActiveSite()
  } catch {
    return null
  }
}

function filterToolRefsForSite(refs: Ref[], site: string | null | undefined): Ref[] {
  if (!refs.some(r => r.category === 'jira')) return refs
  if (site === undefined) return refs
  if (site === null) return refs.filter(r => r.category !== 'jira')
  const active = site.toLowerCase()
  return refs.filter(r => r.category !== 'jira' || r.site.toLowerCase() === active)
}

async function filterToolRefs(refs: Ref[]): Promise<Ref[]> {
  return filterToolRefsForSite(refs, await activeJiraSite())
}

/**
 * Copies the tool statuses to $.state for the pane. Reads first and writes nothing when nothing the pane shows
 * changed, so a quiet tick makes no write (A22).
 */
async function publishTools($: EngineInterface): Promise<void> {
  const g = gh
  const a = acli
  if (!g || !a) return
  const next = { gh: g.status(), acli: a.status() }
  if (shown(await read($, tools)) === shown(next)) return
  await update($, tools, () => next)
}

/** Change the list in $.state and arm the store write. Every write to `items` goes through here. */
async function setItems($: EngineInterface, change: (list: ItemRecord[]) => ItemRecord[]): Promise<void> {
  await update($, items, list => change(list ?? []))
  await schedule($)
}

/** The x button: the manager adds the id to the dismiss list first, drops the item key second, then the trackers hear of it. */
async function dismissOne($: EngineInterface, id: string): Promise<void> {
  try {
    await enter($)
    await managerOf($).dismiss(portsOf($), [id])
  } catch {
    // The row stays. The person can press again.
  }
}

// ------------------------------------------------------------------ session lifecycle

/**
 * /clear, /resume and /branch give a new id and reset $.state, and `session.start` does not fire again. `session.end`
 * runs first and sees the leaving session: the manager stores it and keeps a snapshot. The first hook, tick or flush
 * that finds the new id runs the switch: /clear carries the snapshot into the new state, /resume loads the stored copy
 * of the new id (with the transcript), and an id with no stored copy starts empty.
 * The slots below are the register-local halves of that: they read and write the live state. A tracker will own each
 * one when it moves out of this file.
 */
function managerOf($: EngineInterface): LifecycleManager {
  manager ??= new LifecycleManager(
    {
      trackers: buildTrackers({ autoGithub: autoGithubOf($) }),
      items: legacyHost($),
      dismiss: p => autoDismiss(p.state.slot),
      global: GLOBAL_DEFAULTS,
      paneId: PANE,
    },
    portsOf($),
  )
  return manager
}

/**
 * The GitHub side of the auto tracker's PR lane, over the tool and the session repo this file still holds (the item
 * runtime takes them over in Task 11, and the PR lane moves to the github tracker in L5). The tracker is built before
 * the tools are, so every member looks the tool up when it is called and fails with `not ready` before that.
 */
function autoGithubOf($: EngineInterface): AutoGithub {
  const need = (): GhTool => {
    if (!gh) throw new Error('gh: not ready')
    return gh
  }
  const discovery: GitHubDiscoveryApi = {
    get name() {
      return 'gh' as const
    },
    get isAvailable() {
      return gh?.isAvailable ?? false
    },
    canCall: now => need().canCall(now),
    refreshItems: async targets => need().refreshItems(targets),
    reset: () => need().reset(),
    status: () => need().status(),
    isHostAuthed: host => need().isHostAuthed(host),
    checkHost: async host => need().checkHost(host),
    defaultRepo: async () => need().defaultRepo(),
    graphql: async (host, query) => need().graphql(host, query),
  }
  return {
    discovery,
    ready: async () => {
      const g = need()
      await g.probe()
      return g.isAvailable
    },
    repo: async () => {
      need()
      await ensureRepo($)
      return sessionRepo ?? null
    },
    hosts: () => githubHosts,
  }
}

function factsOf($: EngineInterface): FactsPort {
  return managerOf($).facts
}

/** The processes tracker publishes its probe state under this name (`trackers/processes/watch.ts`). */
const PROCESS_UI_FACT = 'processes.ui'

/** The probe state of the processes tracker as the pane and the `/track` text show it. Idle before the first probe. */
function processUi($: EngineInterface): ProcessUiState {
  return (factsOf($).read(PROCESS_UI_FACT) as unknown as ProcessUiState | undefined) ?? { breaker: 'closed' }
}

/**
 * The first step of every event hook, command and button press: the session check, then the watchdog of the 30 s tick
 * (A1). One refused period ends a `clock.every` for good, so all of them come through here. Render hooks do not: a
 * render must not start timers. It builds the runtime first: a switch that loads a session needs the tools.
 */
function enter($: EngineInterface): Promise<void> {
  ensureRuntime($)
  return managerOf($).entry(portsOf($))
}

const isEmpty = (v: Json | undefined): boolean => !Array.isArray(v) || v.length === 0

/** The item list as a slot. A carry and a load differ: a load filters the stored copy and reads the transcript. */
function itemsSlot($: EngineInterface): DataSlot {
  return {
    id: 'items',
    persist: true,
    read: async () => (await read($, items)) as unknown as Json,
    empty: isEmpty,
    settle: async (live, stored) => {
      // The stored copy can predate the last presses: an item the person dismissed since, or a mark they changed (D6).
      const dismissed = new Set((await readAuto($)).dismissed)
      const kept = ((stored ?? []) as unknown as ItemRecord[]).filter(rec => !dismissed.has(rec.key))
      return rekeyArtifacts(carryOver((live ?? []) as unknown as ItemRecord[], kept)) as unknown as Json
    },
    restore: async (value, how) => {
      const list = value as unknown as ItemRecord[]
      if (how === 'load') {
        resetRepo($) // the session has its own repo: the transcript is read against it, not against the old one
        return loadItems($, list)
      }
      if (list.length > 0) await setItems($, cur => unionRecords(list, cur))
    },
    clear: () => setItems($, () => []),
  }
}

/**
 * The item host over the code this file still holds: the list, the capture funnel, the refresh coordinator and the
 * tools. Task 11 moves them into the item runtime.
 */
function legacyHost($: EngineInterface): ItemsHost {
  return {
    slot: itemsSlot($),
    // The tools, the coordinator and the auto round are built here, before the session load needs them (D4).
    start: async () => {
      ensureRuntime($)
      // A hot reload keeps $.state. Rows an older version stored as web links move (R13).
      const live = await read($, items)
      if (rekeyArtifacts(live) !== live) await setItems($, rekeyArtifacts)
    },
    // The four door hooks below still capture, until Task 11 moves the funnel here.
    capture: async () => {},
    replay: batch => replayItems($, batch),
    dispose: () => {},
    list: async () => (await read($, items)) as unknown as StoredItem[],
    update: async (change, opts) => {
      const m = managerOf($)
      await m.watch.check()
      if (opts?.since !== undefined && opts.since !== m.generation) return false
      // The dismiss list is read again before the write: an x press while the first change ran must win (A20).
      const dismissedNow = async (): Promise<ReadonlySet<string>> => new Set((await readAuto($)).dismissed)
      const cur = (await read($, items)) as unknown as StoredItem[]
      if (change(cur, await dismissedNow()) === cur) return false
      const dismissed = await dismissedNow()
      await setItems($, list => change(list as unknown as StoredItem[], dismissed) as unknown as ItemRecord[])
      return true
    },
    track: (refs, source) => trackRefs($, refs as unknown as Ref[], source as Source),
    refresh: keys => {
      coordinator?.kick('capture', keys === undefined ? undefined : [...keys])
    },
    sessionChanged: async () => {
      resetRepo($)
      await publishTools($) // the tools atom was reset too
    },
    // The share of one beat that is not the session check: find the repo again (after /clear), then one refresh. The
    // trackers' ticks (the auto round, the process probe) come from the bus.
    tick: async () => {
      try {
        ensureRuntime($)
        await ensureRepo($)
      } catch {
        // The beat still kicks the refresh.
      }
      coordinator?.kick('tick')
    },
  }
}

/** The session repo is found again for the new session. */
function resetRepo($: EngineInterface): void {
  sessionRepo = undefined
  repoTask = undefined
  const facts = factsOf($)
  facts.publish('session.repo', undefined)
  facts.publish('github.hosts', undefined)
}

/** Finds the session repo once per session: git remote first, else one `gh repo view`. */
function ensureRepo($: EngineInterface): Promise<void> {
  repoTask ??= resolveRepo($)
  return repoTask
}

async function resolveRepo($: EngineInterface): Promise<void> {
  let repo: RepoRef | null = null
  try {
    const info = await $.session.repo()
    if (info?.remote) repo = parseRemote(info.remote)
    const g = gh
    if (g) {
      // A remote host that gh does not know is an ssh alias (git@github-work:o/r) or not GitHub at all.
      // Drop it and ask `gh repo view`, which resolves aliases.
      if (repo && repo.host !== 'github.com') {
        await g.probe()
        if (g.isAvailable && (await g.checkHost(repo.host))) githubHosts = [repo.host]
        else repo = null
      }
      if (!repo) {
        await g.probe()
        if (g.isAvailable) {
          repo = await g.defaultRepo()
          if (repo && repo.host !== 'github.com') {
            if (await g.checkHost(repo.host)) githubHosts = [repo.host]
            else repo = null
          }
        }
      }
    }
  } catch {
    repo = null // No repo: bare #N stays unresolved.
  }
  sessionRepo = repo
  const facts = factsOf($)
  facts.publish('session.repo', (repo ?? undefined) as unknown as Json | undefined)
  facts.publish('github.hosts', [...githubHosts])
  if (repo) {
    const known = repo
    try {
      await setItems($, list => resolveBareRefs(list, known))
    } catch {
      // A refused write must not poison `repoTask`. Every later capture awaits it.
    }
    coordinator?.kick('capture')
  }
}

// ------------------------------------------------------------------ capture

/** Scan text and merge the refs into the session list. Never throws into the caller. */
async function capture($: EngineInterface, text: string, mode: ScanMode, source: Source): Promise<void> {
  if (text === '') return
  await enter($)
  await ensureRepo($)
  if (mode === 'full') await captureMentions($, text, source).catch(() => {}) // a file fault must not stop the refs
  let refs = extractRefs(text, {
    mode,
    defaultRepo: sessionRepo ?? null,
    githubHosts,
    strictShortRefs: mode === 'full',
  })
  if (mode === 'full') refs = await keepOpenSessionShortRefs(refs)
  if (source === 'tool' && mode === 'urls-only') refs = await filterToolRefs(refs)
  await trackRefs($, refs, source)
}

/** Merge refs into the session list, less the dismissed keys. The common tail of every capture. */
async function trackRefs($: EngineInterface, refs: readonly Ref[], source: Source): Promise<void> {
  const dismissed = new Set((await readAuto($)).dismissed)
  const keep = refs.filter(ref => !dismissed.has(keyOf(ref)))
  if (keep.length === 0) return
  let added: string[] = []
  await setItems($, list => {
    const merged = mergeRefs(list, keep, { source, at: Date.now() })
    added = merged.added
    return merged.list
  })
  if (added.length > 0) coordinator?.kick('capture', added)
}

/**
 * An Artifact tool call (issue #29). A publish tracks the page with source `publish`. A delete marks its row;
 * a dismissed or unknown artifact gets no row. Errors, refusals and other actions change nothing.
 */
async function applyArtifactCall($: EngineInterface, input: unknown, ran: unknown): Promise<void> {
  const ev = artifactEvent(input, ran)
  if (!ev) return
  if (ev.kind === 'published') return trackRefs($, [ev.ref], 'publish')
  const cur = await read($, items)
  if (markArtifactDeleted(cur, ev.key) === cur) return // no such row: a write would change nothing (A22)
  await setItems($, list => markArtifactDeleted(list, ev.key))
}

function sameSessionRepo(ref: Ref): ref is GitHubRef & { owner: string; repo: string; type: 'unknown' } {
  if (
    ref.category !== 'github' ||
    ref.short !== true ||
    ref.type !== 'unknown' ||
    !ref.owner ||
    !ref.repo ||
    !sessionRepo
  )
    return false
  return (
    ref.host.toLowerCase() === sessionRepo.host.toLowerCase() &&
    ref.owner.toLowerCase() === sessionRepo.owner.toLowerCase() &&
    ref.repo.toLowerCase() === sessionRepo.repo.toLowerCase()
  )
}

async function keepOpenSessionShortRefs(refs: Ref[]): Promise<Ref[]> {
  const probe = gh
  if (!probe) return refs.filter(ref => !sameSessionRepo(ref))
  const candidates = refs.filter(sameSessionRepo)
  if (candidates.length === 0) return refs
  const targets: GitHubTarget[] = candidates.map(ref => ({
    key: keyOf(ref),
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    type: ref.type,
  }))
  await probe.refreshItems(targets)
  // GhTool sets either `error` or a normalized lower-case `state` for each queried item.
  const keep = new Set(targets.filter(t => t.error === undefined && t.state === 'open').map(t => t.key))
  return refs.filter(ref => !sameSessionRepo(ref) || keep.has(keyOf(ref)))
}

// ------------------------------------------------------------------ Markdown files (issue #28)

type FileEnv = { home?: string; configDir?: string; memoryDir?: string }

/** Read once per process: every Write, Edit, Read and mention needs it (issue #28 study, "Resolve and label"). */
let fileEnvTask: Promise<FileEnv> | undefined

function fileEnv($: EngineInterface): Promise<FileEnv> {
  fileEnvTask ??= readFileEnv($)
  return fileEnvTask
}

/**
 * HOME, the Claude config dir (`CLAUDE_CONFIG_DIR`, else `$HOME/.claude`) and the `autoMemoryDirectory` setting.
 * The setting is newer than the pinned types, so it is read as plain data. Unset or unreadable: absent.
 */
async function readFileEnv($: EngineInterface): Promise<FileEnv> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const dir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const configDir = dir ? normalizePath(dir) : home ? normalizePath(`${home}/.claude`) : undefined
  const settings: unknown = await $.settings.read().catch(() => undefined)
  const mem = isRecord(settings) && typeof settings.autoMemoryDirectory === 'string' ? settings.autoMemoryDirectory : ''
  const memoryDir = mem ? resolvePath(mem, configDir ?? '/', home) : null
  return { ...(home ? { home } : {}), ...(configDir ? { configDir } : {}), ...(memoryDir ? { memoryDir } : {}) }
}

/** Where an absolute path lands: the real path from one stat, else the path itself. */
async function landed($: EngineInterface, path: string): Promise<{ path: string; exists: boolean }> {
  const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (!st) return { path, exists: false }
  return { path: st.realPath ? normalizePath(st.realPath) : path, exists: st.kind === 'file' }
}

/** What a file sighting needs: the cwd of a relative path, HOME for `~/`, and the ignore rule's root and config dir. */
type FileCtx = IgnoreContext & { cwd: string; home?: string }

/** A subagent's relative path joins its spawn cwd (A6); everything else joins the session cwd. */
async function fileCtx($: EngineInterface, agentId?: string): Promise<FileCtx> {
  const auto = await readAuto($)
  const spawn = agentId === undefined ? undefined : auto.agents.find(a => a.id === agentId)?.cwd
  return {
    ...(await fileEnv($)),
    cwd: spawn ?? (await $.session.cwd()),
    ...(auto.root ? { root: auto.root.cwd } : {}),
  }
}

/** One sighting of a Markdown file. null: an ignored path, or a mention of a file that is not there. */
async function sighting(
  $: EngineInterface,
  ctx: FileCtx,
  spelled: string,
  kind: FileActivity,
  bySubagent: boolean,
  s: Sighting,
): Promise<FileRecord | null> {
  const label = resolvePath(spelled, ctx.cwd, ctx.home)
  if (label === null || isIgnored(label, ctx)) return null
  const hit = await landed($, label)
  if (kind === 'mentioned' && !hit.exists) return null
  return recordFromFile({ path: hit.path, label, kind, bySubagent }, s)
}

/** Drops the views of files that no earlier sighting tracks: a Read alone never adds a row. */
function withoutLoneViews(list: readonly ItemRecord[], recs: readonly FileRecord[]): FileRecord[] {
  const known = new Set(list.map(i => i.key))
  return recs.filter(r => {
    if (r.views > 0) return known.has(r.key)
    known.add(r.key)
    return true
  })
}

/** Merges file sightings into the list. A dismissed key never comes back. */
async function addFiles($: EngineInterface, recs: readonly FileRecord[]): Promise<void> {
  const dismissed = new Set((await readAuto($)).dismissed)
  const wanted = recs.filter(r => !dismissed.has(r.key))
  if (withoutLoneViews(await read($, items), wanted).length === 0) return // only views of untracked files: no write
  await setItems($, list => mergeFiles(list, withoutLoneViews(list, wanted)))
}

/** A Write, Edit or Read result: one sighting of the file it touched. */
async function captureFileTouch($: EngineInterface, t: FileTouch, agentId: string | undefined): Promise<void> {
  const ctx = await fileCtx($, agentId)
  const rec = await sighting($, ctx, t.spelled, t.kind, agentId !== undefined, { source: 'tool', at: Date.now() })
  if (rec) await addFiles($, [rec])
}

/** `.md` paths that a prompt or reply names and that exist: one `mentioned` sighting each (R8). */
async function mentionRecords($: EngineInterface, ctx: FileCtx, text: string, s: Sighting): Promise<FileRecord[]> {
  const recs: FileRecord[] = []
  for (const name of mdCandidates(text)) {
    const rec = await sighting($, ctx, name, 'mentioned', false, s)
    if (rec) recs.push(rec)
  }
  return recs
}

async function captureMentions($: EngineInterface, text: string, source: Source): Promise<void> {
  if (mdCandidates(text).length === 0) return // most rows name no file: no state read
  const recs = await mentionRecords($, await fileCtx($), text, { source, at: Date.now() })
  if (recs.length > 0) await addFiles($, recs)
}

/** The Write, Edit and Read hooks: track the Markdown file. The auto tracker counts the call as a sign of life (A7). */
async function onFileTool($: EngineInterface, tool: string, ran: unknown, agentId: string | undefined): Promise<void> {
  try {
    await enter($)
    const t = touchFromToolResult(tool, ran)
    if (t) await captureFileTouch($, t, agentId)
  } catch {
    // Tracking a file must not change the tool result.
  }
}

// ------------------------------------------------------------------ store

/**
 * Copy the lists to $.store later. Many changes in one burst make one write.
 * A timer that a hook refused never runs. So a pending timer that is long overdue is replaced.
 * Never rejects.
 */
function schedule($: EngineInterface): Promise<void> {
  return managerOf($).persistence.touch()
}

// ------------------------------------------------------------------ restore

/**
 * Wrappers of user-role rows that the person did not type. `SessionMessage` has no `isMeta` or `origin`,
 * so the backfill can only skip the wrappers it knows (D3 lets the live hook use the real flags).
 */
const NOT_TYPED = ['<local-command-stdout>', '<task-notification>', '<system-reminder>', '<teammate-message']

/** The text a transcript message offers, by the rules of its row door. null: skip it. */
function backfillText(role: 'user' | 'assistant', text: string): string | null {
  if (text === '') return null
  if (role === 'assistant') return text
  if (NOT_TYPED.some(tag => text.includes(tag))) return null
  return text.includes('<command-args>') ? commandArgs(text) : text
}

/**
 * Items from a replayed transcript batch: a `--resume` load fires no append hooks. File rows come from the Write, Edit
 * and Read results and the mentions, artifact rows from the Artifact tool uses, in transcript order. A subagent's
 * transcript stores no result, so its writes and publishes come back from the stored copy only.
 */
async function fromBatch($: EngineInterface, batch: readonly ReplayItem[]): Promise<ItemRecord[]> {
  // In transcript order, so a delete lands after the publish before it.
  const batches: ({ refs: Ref[]; source: Source } | { deleted: string })[] = []
  const fileRecs: FileRecord[] = []
  const opts = { defaultRepo: sessionRepo ?? null, githubHosts }
  const toolSite = await activeJiraSite()
  const ctx = await fileCtx($)
  const at = Date.now()
  for (const item of batch) {
    if (item.kind === 'row') {
      const role = item.ev.door === 'prompt' ? 'user' : 'assistant'
      const text = backfillText(role, item.ev.text)
      if (text === null) continue
      const source: Source = role === 'user' ? 'prompt' : 'response'
      batches.push({
        refs: await keepOpenSessionShortRefs(extractRefs(text, { mode: 'full', ...opts, strictShortRefs: true })),
        source,
      })
      fileRecs.push(...(await mentionRecords($, ctx, text, { source, at })))
      continue
    }
    const { tool, input, result: use } = item.ev // `use` is the whole tool use of the transcript
    const t = touchFromToolResult(tool, use)
    const rec = t && (await sighting($, ctx, t.spelled, t.kind, false, { source: 'tool', at }))
    if (rec) fileRecs.push(rec)
    if (tool === 'Artifact') {
      const ev = artifactEvent(input, use)
      if (ev?.kind === 'published') batches.push({ refs: [ev.ref], source: 'publish' })
      else if (ev?.kind === 'deleted') batches.push({ deleted: ev.key })
    }
    const text = isRecord(use) && typeof use.text === 'string' ? use.text : ''
    if (!text) continue
    const refs = filterToolRefsForSite(extractRefs(text, { mode: 'urls-only', ...opts }), toolSite)
    if (refs.length > 0) batches.push({ refs, source: 'tool' })
  }
  let list: ItemRecord[] = []
  for (const b of batches) {
    if ('deleted' in b) list = markArtifactDeleted(list, b.deleted)
    else if (b.refs.length > 0) list = mergeRefs(list, b.refs, { source: b.source, at }).list
  }
  return mergeFiles(list, withoutLoneViews(list, fileRecs))
}

/** A stored record comes back due: its status stays for display, its refresh time goes. */
function due(rec: ItemRecord): ItemRecord {
  const out = { ...rec }
  delete out.refreshedAt
  return out
}

/** A stored copy comes back without auto sources: a new process has no proofs, so the first complete PR step adds back what is still tracked. */
function withoutAuto(list: ItemRecord[]): ItemRecord[] {
  const keys = new Set(
    list.filter(r => r.via !== undefined || r.sources.some(s => AUTO_SOURCES.has(s))).map(r => r.key),
  )
  return dropAuto(list, keys)
}

function keepStored(rec: ItemRecord, activeSite: string | null | undefined): boolean {
  if (rec.category !== 'jira') return true
  if (activeSite === undefined) return true
  if (rec.sources.length !== 1 || rec.sources[0] !== 'tool') return true
  return activeSite !== null && rec.site.toLowerCase() === activeSite.toLowerCase()
}

/**
 * The items of a stored copy. A `--resume` load and a /resume switch both come here, with the list empty: the caller
 * checked. The transcript is not read here: Replay hands it over after the load. Does not wait for the repo, which
 * may need `gh` calls of up to 30 s.
 */
async function loadItems($: EngineInterface, storedItems: ItemRecord[]): Promise<void> {
  // Bare #N is re-keyed when the repo arrives.
  const repoReady = ensureRepo($).catch(() => {})
  const activeSite = await activeJiraSite()
  const dismissed = new Set((await readAuto($)).dismissed)
  const stored = withoutAuto(rekeyArtifacts(storedItems))
    .filter(rec => keepStored(rec, activeSite))
    .filter(rec => rec.error?.kind !== 'not-found')
    .filter(rec => !dismissed.has(rec.key))
    .map(due)
  if (stored.length === 0) return
  await setItems($, list => unionRecords(list, stored))
  afterLoad($, repoReady)
}

/**
 * The transcript of a cold load or a cold resume, after the stored copy. A stored key wins over the transcript, except
 * for what only the transcript may know of an artifact: a publish or a delete that landed after the last flush.
 */
async function replayItems($: EngineInterface, batch: readonly ReplayItem[]): Promise<void> {
  const repoReady = ensureRepo($).catch(() => {})
  await activeJiraSite() // learns the site now, so the first refresh finds it cached
  const dismissed = new Set((await readAuto($)).dismissed)
  const have = new Map((await read($, items)).map(r => [r.key, r]))
  const news = (r: ItemRecord): boolean => {
    const old = have.get(r.key)
    if (!old) return true
    if (r.category !== 'artifact' || old.category !== 'artifact') return false
    return (artifactOrigin(r) === 'published' && artifactOrigin(old) === 'mentioned') || (!!r.deleted && !old.deleted)
  }
  const fresh = batch.length === 0 ? [] : (await fromBatch($, batch)).filter(r => news(r) && !dismissed.has(r.key))
  if (fresh.length === 0) return
  await setItems($, list => unionRecords(list, fresh))
  afterLoad($, repoReady)
}

/** After items came in: bare #N waits for the repo, then the refresh picks them up. */
function afterLoad($: EngineInterface, repoReady: Promise<void>): void {
  void repoReady
    .then(async () => {
      const repo = sessionRepo
      if (repo) await setItems($, list => resolveBareRefs(list, repo))
    })
    .catch(() => {})
  coordinator?.kick('capture')
}

// ------------------------------------------------------------------ /track

/** The view context from what is known now. It does not wait for the repo: a render must not wait on `gh`. */
async function contextOf($: EngineInterface, bodyColumns?: number): Promise<ViewContext> {
  // When the last auto round ended. The Worktrees note reads it before `snapshot.at` (A22).
  const autoCheckedAt = factsOf($).read<number>('auto.checkedAt')
  return {
    now: Date.now(),
    folded: (await read($, ui)).folded,
    tools: viewTools(await read($, tools)),
    sessionRepo,
    auto: await readAuto($),
    ...(autoCheckedAt !== undefined ? { autoCheckedAt } : {}),
    ...(bodyColumns !== undefined ? { bodyColumns } : {}),
  }
}

/** The context of the `/track` text: waits for the repo first, so `#N` keys are right. */
async function viewContext($: EngineInterface): Promise<ViewContext> {
  await ensureRepo($)
  return contextOf($)
}

async function listText($: EngineInterface): Promise<string> {
  return composeCommandText(
    await read($, items),
    await readProcesses($),
    processUi($),
    await viewContext($),
    await readRepos($),
  )
}

/** Waits for both `--version` probes (cached, so cheap) and publishes the statuses for the sections. */
async function settleProbes($: EngineInterface): Promise<void> {
  if (!gh || !acli) return
  await Promise.allSettled([gh.probe(), acli.probe()])
  await publishTools($)
}

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'Tracking', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) $.ui.toast('Widen the terminal to see the tracking pane')
}

// ------------------------------------------------------------------ priority keys

/**
 * The priority keys act on the picked row: the row whose Button last took the pane's focus ring, or whose mark was
 * pressed. `0` (level undefined) removes the person's mark. The row moves when it sorts again, but the ring stays at
 * its old place (study S3). So the ring is moved to the row's new mark Button, whose key only the next drawing has
 * (S4). In a test kit `$.ui.focus` has no implementation, and live it may be refused: the move is best effort.
 */
async function prioritize($: EngineInterface, level: Priority | undefined): Promise<void> {
  const id = focusedRow
  if (id === undefined) return
  try {
    await enter($)
    await setItems($, list => setPriority(list, id, level))
  } catch {
    return // The mark stays. The person can press again.
  }
  try {
    const sections = composePane(await read($, items), await readProcesses($), processUi($), await contextOf($))
    const key = markKeys(sections).get(id)
    if (key !== undefined) await $.ui.focus({ requestId: PANE, key })
  } catch {
    // The ring stays where it is. The next Tab moves it.
  }
}

// ------------------------------------------------------------------ hooks

export const register: Register = on => {
  // Every row, whatever the door: the manager captures it and gives it to the trackers that declared the door. The
  // four door hooks below still capture until Task 11. The list is a literal, so a new door edits this line (E17).
  on(
    'session.append',
    {
      door: [
        'prompt',
        'command',
        'response',
        'tool-result',
        'tool-message',
        'delivery',
        'attachment',
        'hook-context',
        'note',
        'compaction',
        'notice',
        'queue',
      ],
    },
    async ($, e, next) => {
      const stored = await next(e)
      try {
        await managerOf($).row(portsOf($), rowEvent(e, stored))
      } catch {
        // A tracker fault must not touch the row.
      }
      return stored
    },
  ).catch((_$, e, next) => next(e))

  // Every tool call: the trackers pick the tools they declared. A persisted `cd` moves the session cwd during the run,
  // so it is read before the call, and only when a tracker wants this tool.
  on('tool.call', async ($, e, next) => {
    const m = managerOf($)
    const cwdBefore = m.wants(e.tool) ? ((await $.session.cwd().catch(() => undefined)) ?? undefined) : undefined
    const ran = await next(e)
    try {
      await m.toolCall(portsOf($), toolCallEvent(e, ran, cwdBefore))
    } catch {
      // The tool result goes back unchanged.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  // The person's typed prompt. Machines and notifications are not the person's text (D3).
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      await enter($) // the first row of a new session carries the old one over, whatever the row is
      if (PERSON.has(e.origin.kind) && !stored.message?.isMeta && e.agentId === undefined && stored.message) {
        await capture($, textOfContent(stored.message.content), 'full', 'prompt')
      }
    } catch {
      // A scanner or state fault must not touch the row.
    }
    return stored
  }).catch((_$, e, next) => next(e))

  // The person's slash command. Only the arguments count. Our own `/track` output has origin `engine`.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      await enter($) // a /clear appends its own command row first: the switch runs here
      if (e.origin.kind === 'composer' && stored.message) {
        await capture($, commandArgs(textOfContent(stored.message.content)), 'full', 'prompt')
      }
    } catch {
      // See above.
    }
    return stored
  }).catch((_$, e, next) => next(e))

  // Claude's text, also from subagents.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      if (stored.message) await capture($, textOfContent(stored.message.content), 'full', 'response')
    } catch {
      // See above.
    }
    return stored
  }).catch((_$, e, next) => next(e))

  // Tool output. Explicit GitHub and Jira URLs only.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      if (stored.message) await capture($, textOfContent(stored.message.content), 'urls-only', 'tool')
    } catch {
      // See above.
    }
    return stored
  }).catch((_$, e, next) => next(e))

  // The Artifact tool: a publish tracks the page, a delete marks its row. The result goes back unchanged.
  on('tool.call', { tool: 'Artifact' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await enter($)
      await applyArtifactCall($, e, ran)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  // Once per process: register the command, then the start sequence of the manager: the run record, the trackers
  // (the auto tracker pins the root), the stored session and the transcript of a resume, the tick and the pane.
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'track',
        description: 'Show tracked GitHub, Jira, artifacts, web links and Markdown files',
        argumentHint: '[refresh|clear|prio <ref> <level>]',
      })
    } catch {
      // The command may be refused. Capture and restore still work.
    }
    try {
      await managerOf($).start(portsOf($), { cwd: e.cwd, fromSessionStart: true })
    } catch {
      // The start sequence logs its own faults. The session goes on.
    }
    await enter($).catch(() => {}) // A1: the tick runs from the start, with the pane open or closed
    return next(e)
  }).catch((_$, e, next) => next(e))

  // The leaving session is stored here, while $.state and the id are still its own (E6). Before `next`, within the budget.
  on('session.end', async ($, e, next) => {
    try {
      await managerOf($).end(portsOf($), e.reason, next.budget.remainingMs)
    } catch {
      // Storing is best effort: the session must still end.
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'track' }, async ($, e) => {
    await enter($)
    const g = gh
    const a = acli
    const c = coordinator
    if (!g || !a || !c) return { text: 'artifact-tracking: not ready.' }
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      // In `claude -p` the command may run before acli answers `--version`. The probes are cached.
      // Wait for them and for the repo first, so the pane's first drawing is already right (also after /clear).
      await settleProbes($)
      await ensureRepo($)
      await managerOf($).command(portsOf($), { sub: '', args: '', wait: true })
      await openPane($)
      c.kick('open')
      return { text: await listText($) }
    }
    if (arg === 'refresh') {
      await settleProbes($)
      g.reset()
      a.reset()
      const run = await c.runDue({ force: true })
      if (run.skipped) {
        // A run was in flight: the forced run is queued behind it. Wait, then publish the tool status again.
        // The publish is also a write of this dispatch. Without it the reads below still show the moment
        // before the runs (`$.state.get` reads one moment for each dispatch).
        await c.idle()
        await publishTools($)
      }
      // The trackers refresh too: the auto tracker runs a round and waits for it and its PR step.
      await managerOf($).command(portsOf($), { sub: 'refresh', args: '', wait: true })
      return { text: await listText($) }
    }
    if (arg === 'clear') {
      // The auto tracker hides its current items first, so the next tick does not bring them back (A14).
      await managerOf($).command(portsOf($), { sub: 'clear', args: '', wait: true })
      await managerOf($).clear(portsOf($))
      return { text: 'Tracking list cleared.' }
    }
    // R11: the pane's keys for `claude -p`. The ref keeps its case: Jira keys and repo names need it.
    const prio = /^prio\s+(\S+)\s+(\S+)$/i.exec(e.args.trim())
    const word = prio?.[2]?.toLowerCase()
    if (prio && word !== undefined && PRIO_WORDS.has(word)) {
      const ref = prio[1] ?? ''
      await ensureRepo($)
      const id = rowIdOf(await read($, items), ref, { defaultRepo: sessionRepo ?? null, githubHosts })
      if (id === undefined) return { text: `Not tracked: ${ref}` }
      await setItems($, list => setPriority(list, id, word === 'auto' ? undefined : (word as Priority)))
      try {
        await managerOf($).flushNow() // `claude -p` can exit right after the reply: save now, not after flushMs
      } catch {
        // The next change saves it.
      }
      return { text: await listText($) }
    }
    return { text: USAGE }
  }).catch(() => ({ text: 'artifact-tracking: could not run the command.' }))

  // The person moves the pane's ring. A Button of an item row picks that row; the footer keys keep the pick, so
  // Enter on `1: high` still acts on it. Another Button, or one of the engine's own stops, drops it.
  on('ui.focus', { requestId: PANE }, (_$, e, next) => {
    const id = e.element === undefined ? undefined : focusRows.get(e.element)
    if (id !== undefined) focusedRow = id
    else if (e.element !== undefined ? !e.element.startsWith('prio-') : e.origin?.kind === 'person')
      focusedRow = undefined
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.close', { id: PANE }, (_$, e, next) => {
    focusedRow = undefined
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const list = await read($, items)
    const sections = composePane(
      list,
      await readProcesses($),
      processUi($),
      await contextOf($, e.props.bodyColumns),
      await readRepos($),
    )
    focusRows = focusTargets(sections)
    return renderSections(el, sections, e.props.bodyColumns, {
      fold: id => {
        void update($, ui, u => {
          const folded = u?.folded ?? []
          return { folded: folded.includes(id) ? folded.filter(x => x !== id) : [...folded, id] }
        })
      },
      refresh: () => {
        ensureRuntime($)
        coordinator?.kick('manual')
        void managerOf($)
          .command(portsOf($), { sub: 'manual', args: '', wait: false })
          .catch(() => {})
      },
      dismiss: id => {
        void dismissOne($, id)
      },
      focus: id => {
        focusedRow = id
      },
      prioritize: level => {
        void prioritize($, level)
      },
    })
  }).catch(($, e) => {
    // A failed read must not close the pane. Draw one line instead.
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Tracking is unavailable. Run /track to try again.</Text>
  })

  // One line above the prompt. The engine's own band stays inside our Box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = composeBand(await read($, items), await readProcesses($), await readAuto($), await readRepos($))
    if (text === null || e.props.hasSurvey) return next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    return (
      <Box flexDirection="column">
        {renderBand(el, text)}
        {await next(e)}
      </Box>
    )
  }).catch((_$, e, next) => next(e)) // a failed read leaves the band to the engine

  // Markdown files that Claude writes, edits or reads (issue #28). Successful calls only; the reply goes back unchanged.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await onFileTool($, 'Write', ran, e.agentId)
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await onFileTool($, 'Edit', ran, e.agentId)
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    await onFileTool($, 'Read', ran, e.agentId)
    return ran
  }).catch((_$, e, next) => next(e))

  // A subagent or a workflow agent starts. `next` gives its id. The master cwd is read before `next`: it is the
  // spawn-time location of a child of the main loop (A6). The trackers hear of it in `order`: the auto tracker records
  // the spawn first, the repos tracker reads the agent's cwd from the ledger.
  on('agent.spawn', async ($, e, next) => {
    let sessionCwd: string | undefined
    if (e.cwd === undefined && e.parentAgentId === undefined) sessionCwd = await $.session.cwd().catch(() => undefined)
    const out = await next(e)
    try {
      await managerOf($).agentSpawn(portsOf($), spawnEvent(e, out, sessionCwd))
    } catch {
      // The spawn answer goes back unchanged.
    }
    return out
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    try {
      await managerOf($).turnComplete(portsOf($), turnEvent(e)) // a main-loop turn re-arms the tick: the manager's entry
    } catch {
      // See above.
    }
    return out
  }).catch((_$, e, next) => next(e))
}

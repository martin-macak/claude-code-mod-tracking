// Wiring for the artifact-tracking mod. The only file that touches `$`.
// Capture hooks observe rows. A coordinator refreshes the items with gh and acli. A pane and a band draw them.
// Specs: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md sections 6 to 10, and
// docs/superpowers/specs/2026-10-10-auto-tracking-design.md (the `auto` atom, the tick, the round, the hooks of spec 7).

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { CircuitBreaker } from '../core/infra/circuit-breaker'
import type { Timer } from '../core/infra/coordinator'
import { RefreshCoordinator } from '../core/infra/coordinator'
import { autoIds, dismiss } from '../core/infra/dismiss'
import { GLOBAL_DEFAULTS } from '../core/infra/global-defaults'
import { LifecycleManager } from '../core/infra/lifecycle'
import { AutoScheduler } from '../core/infra/scheduler'
import type { ItemsHost, Json, StoredItem } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import type { DataSlot } from '../core/interfaces/slots'
import type { FactsPort } from '../core/interfaces/tracker'
import { isRecord } from '../core/lib/json'
import { textOfContent } from '../core/lib/links'
import { artifactEvent } from '../trackers/artifact/artifact-tool'
import { fromAgentResult, fromBash, fromEnterResult, fromSpawn, fromTurnEnd } from '../trackers/auto/events'
import {
  carryAuto,
  emptyAuto,
  pinRoot,
  recordActivity,
  recordAgentBranch,
  recordAgentResult,
  recordEnter,
  recordSpawn,
  recordTurnEnd,
} from '../trackers/auto/ledger'
import { AutoRound } from '../trackers/auto/round'
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
import {
  monitorRow,
  parseBashProcesses,
  processUpdateFromNotification,
  processUpdateFromNotificationText,
  processUpdateFromTaskStop,
} from '../trackers/processes/parse'
import {
  composeState,
  dockerEntryMatchesRow,
  findDetachedPid,
  parseDockerPs,
  psStillMatches,
  screenLive,
  tmuxLive,
} from '../trackers/processes/probe'
import {
  extractRepoPathsFromTool,
  PATH_TOOLS,
  parseRepoHintsFromBash,
  type RepoHit,
  repoBaseDir,
} from '../trackers/repos/hints'
import { RepoQueue } from '../trackers/repos/queue'
import { capRepoRows, mergeRepoRows, upsertRepoRows } from '../trackers/repos/rows'
import { RepoTracker, type RepoVisit } from '../trackers/repos/tracker'
import { renderBand } from '../ux/band'
import { renderSections } from '../ux/pane'
import type {
  AutoReason,
  AutoState,
  DiscoveryApplied,
  FileActivity,
  FileRecord,
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
import { AUTO_SOURCES, isRowId, LIMITS, repoRowId } from './contracts'
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
 * fresh value, and a change that returns its input is still seen as "no change".
 * Plain functions, not methods: `claude plugin validate` refuses `$` as an argument of a method call.
 */
async function readSlot<T>($: EngineInterface, id: string, empty: () => T): Promise<T> {
  return ((await portsOf($).state.slot.get(id)) as unknown as T | undefined) ?? empty()
}

async function updateSlot<T>($: EngineInterface, id: string, empty: () => T, change: (cur: T) => T): Promise<T> {
  const next = await portsOf($).state.slot.update(
    id,
    cur => change((cur as unknown as T | undefined) ?? empty()) as unknown as Json,
  )
  return next as unknown as T
}

const noRows = (): never[] => []

function readRepos($: EngineInterface): Promise<RepoRecord[]> {
  return readSlot<RepoRecord[]>($, 'repos', noRows)
}

function updateRepos($: EngineInterface, change: (rows: RepoRecord[]) => RepoRecord[]): Promise<RepoRecord[]> {
  return updateSlot<RepoRecord[]>($, 'repos', noRows, change)
}

function readProcesses($: EngineInterface): Promise<ProcessRecord[]> {
  return readSlot<ProcessRecord[]>($, 'processes', noRows)
}

function updateProcesses(
  $: EngineInterface,
  change: (rows: ProcessRecord[]) => ProcessRecord[],
): Promise<ProcessRecord[]> {
  return updateSlot<ProcessRecord[]>($, 'processes', noRows, change)
}

/** The run: root, proofs, agents, dismiss list and the last snapshot (spec 6.2). Never goes to $.store. */
function readAuto($: EngineInterface): Promise<AutoState> {
  return readSlot<AutoState>($, 'auto', emptyAuto)
}

function updateAuto($: EngineInterface, change: (cur: AutoState) => AutoState): Promise<AutoState> {
  return updateSlot<AutoState>($, 'auto', emptyAuto, change)
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
let runCmd: Runner | undefined
const processBreaker = new CircuitBreaker()
let processUiState: ProcessUiState = { breaker: 'closed' }
/** undefined: not resolved yet. null: this session has no known repo. */
let sessionRepo: RepoRef | null | undefined
let repoTask: Promise<void> | undefined
let githubHosts: string[] = []
let tick: Timer | null = null
/** The session switch, the store and the facts of this load. Built on first use; a hot reload builds a new one. */
let manager: LifecycleManager | undefined
/** The first start of a load deletes the keys of the old layout. */
let legacyDropped = false
let scheduler: AutoScheduler | undefined
let round: AutoRound | undefined
/** `$.clock.now()` when the tick was armed, and at each beat (A1). */
let lastBeatAt = 0
/** When the last round ended. The Worktrees note reads it before `snapshot.at` (A22). */
let lastRoundAt: number | undefined
let repoTracker: RepoTracker | undefined
/** Repo lookups run here, one at a time, after the tool has returned. */
const repoQueue = new RepoQueue()
/** The row the priority keys act on. Never stored: a close, a reload or /clear forgets it. */
let focusedRow: string | undefined
/** Element key to row id, for the Buttons of the rows with a prio cell as last drawn (`focusTargets`). */
let focusRows: ReadonlyMap<string, string> = new Map()

// ------------------------------------------------------------------ runtime

/** Builds the tools and the coordinator once. `$` only appears in calls, never as a value. */
function ensureRuntime($: EngineInterface): void {
  if (gh && acli && coordinator && scheduler && round) return
  const run: Runner = (argv, init) => $.process.run(argv, init)
  runCmd = run
  repoTracker = new RepoTracker({
    run,
    now: Date.now,
    get rootPath() {
      const root = factsOf($).read('auto.root') as unknown as AutoState['root'] | undefined
      return root?.top ?? (typeof root?.cwd === 'string' ? root.cwd : undefined)
    },
    get rootRepo() {
      return (factsOf($).read('session.repo') as unknown as RepoRef | undefined) ?? null
    },
  })
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
          await setAuto($, s => dismiss(s, dropped))
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
  const git = (argv: readonly string[], cwd: string) => run(['git', ...argv], { cwd, timeoutMs: LIMITS.gitTimeoutMs })
  const autoRound = new AutoRound({
    now: Date.now,
    load: async () => {
      const s = await readAuto($)
      publishAuto($, s)
      return s
    },
    save: change => setAuto($, change),
    git,
    listAgents: async () =>
      (await $.agent.list()).map(a => ({
        id: a.id,
        status: a.status,
        ...(a.teammateId !== undefined ? { teammateId: a.teammateId } : {}),
      })),
    sessionCwd: () => $.session.cwd(),
    repo: async () => {
      await ensureRepo($)
      return sessionRepo ?? null
    },
    gh: g,
    ghReady: async () => {
      await g.probe()
      return g.isAvailable
    },
    githubHosts: () => githubHosts,
    applyItems: change => applyItems($, change),
    onAdded: keys => {
      if (keys.length > 0) coordinator?.kick('capture', keys)
    },
  })
  round = autoRound
  scheduler = new AutoScheduler({
    now: Date.now,
    after: (ms, fn) => $.clock.after(ms, fn),
    run: async reasons => {
      await autoRound.run(reasons)
      lastRoundAt = Date.now()
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

/**
 * Like setItems, for tracked repositories. Every write to `repos` goes through here, so this is the one place that
 * drops the repos the person dismissed with the x button. It drops them before the cap. Reads first and writes
 * nothing when the result is the input list itself.
 */
async function setRepos($: EngineInterface, change: (rows: RepoRecord[]) => RepoRecord[]): Promise<void> {
  const dismissed = new Set((await readAuto($)).dismissed)
  const apply = (rows: RepoRecord[]): RepoRecord[] => {
    const out = change(rows)
    const kept = dismissed.size === 0 ? out : out.filter(r => !dismissed.has(repoRowId(r.key)))
    return capRepoRows(kept.length === out.length ? out : kept)
  }
  const cur = await readRepos($)
  if (apply(cur) === cur) return // nothing changed: no write, no flush
  await updateRepos($, apply)
  await schedule($)
}

/** Like setItems, for tracked background processes. */
async function setProcesses($: EngineInterface, change: (rows: ProcessRecord[]) => ProcessRecord[]): Promise<void> {
  await updateProcesses($, change)
  await schedule($)
}

/**
 * Change the `auto` member. Every write goes through here (A18, A22). It reads first and stops when the change
 * returns its input: no write. Else `update` runs the change on the current value and retries on a version miss.
 * The hook that calls it has run the session check first, so a /clear has already carried the run into the new state.
 */
async function setAuto($: EngineInterface, change: (cur: AutoState) => AutoState): Promise<AutoState> {
  const cur = await readAuto($)
  if (change(cur) === cur) {
    publishAuto($, cur)
    return cur
  }
  const next = await updateAuto($, change)
  publishAuto($, next)
  return next
}

/** The root and the agent ledger as facts, for the readers that cannot wait: the repo tracker and the `touchedBy` label. */
function publishAuto($: EngineInterface, s: AutoState): void {
  const facts = factsOf($)
  facts.publish('auto.root', (s.root ?? undefined) as unknown as Json | undefined)
  facts.publish('auto.agents', s.agents as unknown as Json)
}

/**
 * The item write of a round. `change` also gets the dismiss list (A20). Reads first and skips `update` when the
 * change returns the input list itself (A22).
 * Like `capture`, it runs the session check first: a PR step that was in flight over /resume must not fill the new,
 * empty list before the switch has loaded the stored copy.
 */
async function applyItems(
  $: EngineInterface,
  change: (list: ItemRecord[], dismissed: ReadonlySet<string>) => DiscoveryApplied,
): Promise<DiscoveryApplied> {
  await managerOf($).watch.check()
  const dismissedNow = async (): Promise<ReadonlySet<string>> => new Set((await readAuto($)).dismissed)
  const cur = await read($, items)
  let result = change(cur, await dismissedNow())
  if (result.list === cur) return result
  const dismissed = await dismissedNow()
  await setItems($, list => {
    result = change(list, dismissed)
    return result.list
  })
  return result
}

/** A sign of life for a workflow agent (A7). A main-loop call has no agent id and does nothing. */
async function touch($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId !== undefined) await setAuto($, s => recordActivity(s, agentId, Date.now()))
}

function touchedBy($: EngineInterface, agentId: string | undefined): string {
  if (agentId === undefined) return 'main'
  const agents = factsOf($).read('auto.agents') as unknown as AutoState['agents'] | undefined
  const label = agents?.find(a => a.id === agentId)?.label
  return label && label !== '' ? label : `agent:${agentId.slice(0, 8)}`
}

/**
 * Queues a repo lookup and returns at once: a lookup costs several git calls and must not hold a tool result back.
 * Who, when, the clear count and the session id are taken now, so the row says who touched the repo even when the job
 * runs late. The job writes nothing after /track clear or a new session id. Never rejects.
 */
function enqueueRepo<T>(
  $: EngineInterface,
  key: string,
  items: readonly T[],
  label: (item: T) => string,
  agentId: string | undefined,
  resolve: (tracker: RepoTracker, item: T, who: string) => Promise<RepoVisit | null>,
): void {
  const tracker = repoTracker
  if (!tracker || items.length === 0) return
  const who = touchedBy($, agentId)
  const at = Date.now()
  const m = managerOf($)
  const gen = m.generation
  const sid = m.watch.lastId
  repoQueue.push(`${key}\0${gen}\0${sid ?? ''}\0${who}\0${items.map(label).join('\0')}`, async () => {
    const visits: RepoVisit[] = []
    for (const item of items) {
      try {
        const v = await resolve(tracker, item, who)
        if (v) visits.push(v)
      } catch {
        // one bad item must not stop the others
      }
    }
    if (visits.length === 0) return
    if ((await m.watch.current()) !== gen) return // a /clear, /resume or /track clear since the job began (D8)
    await setRepos($, rows => {
      let out = rows
      for (const v of visits) out = upsertRepoRows(out, { ...v, at })
      return out
    })
  })
}

function enqueueRepoPaths($: EngineInterface, hits: readonly RepoHit[], agentId: string | undefined): void {
  enqueueRepo(
    $,
    'path',
    hits,
    h => `${h.mode}${h.branchMayChange ? '!' : ''}:${h.path}`,
    agentId,
    (t, h, who) => t.resolvePath(h.path, who, h.mode, { branchMayChange: h.branchMayChange === true }),
  )
}

function enqueueRepoRefs($: EngineInterface, refs: readonly RepoRef[], agentId: string | undefined): void {
  enqueueRepo(
    $,
    'ref',
    refs,
    r => `${r.host}/${r.owner}/${r.repo}`,
    agentId,
    (t, ref, who) => t.fromRepoRef(ref, who),
  )
}

/** A `tool.call` result of a call that was refused (`deny`) or that the tool reported as an error (`isError`). */
const refused = (ran: unknown): boolean =>
  !!ran && typeof ran === 'object' && (ran as { deny?: unknown }).deny !== undefined
const failed = (ran: unknown): boolean =>
  refused(ran) || (!!ran && typeof ran === 'object' && (ran as { isError?: unknown }).isError === true)

/**
 * Arms the 30 s tick, or arms it again when the last beat is over two periods old (A1). One refused period ends a
 * `clock.every` for good, so every hook, kick, command and button press calls this. `now` and `lastBeatAt` both come
 * from `$.clock.now()`. Render hooks do not call it: a render must not start timers. Never rejects.
 */
async function ensureTick($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    if (tick && now - lastBeatAt <= 2 * LIMITS.tickMs) return
    tick?.cancel()
    lastBeatAt = now
    tick = $.clock.every(LIMITS.tickMs, async () => {
      try {
        lastBeatAt = await $.clock.now()
      } catch {
        // Keep the old beat: the watchdog will arm the interval again.
      }
      await beat($)
    })
  } catch {
    // No tick this time. The next hook tries again.
  }
}

/** One beat: find the session and the repo again (after /clear), then one round and one refresh. */
async function beat($: EngineInterface): Promise<void> {
  try {
    ensureRuntime($)
    await enter($)
    await ensureRepo($)
  } catch {
    // The beat still kicks what it can.
  }
  scheduler?.kick('tick')
  coordinator?.kick('tick')
  await probeProcesses($).catch(() => {})
}

/** Builds the runtime if needed, looks at the tick and runs the session check. The first step of every event hook. */
async function arm($: EngineInterface): Promise<void> {
  ensureRuntime($)
  void ensureTick($)
  await enter($)
}

/** An event reason for the round, and a look at the tick. */
function kickAuto($: EngineInterface, reason: AutoReason): void {
  void ensureTick($)
  scheduler?.kick(reason)
}

/** The x button: the `auto` atom first, the items second. The order matters (spec 8, 10.5). */
async function dismissOne($: EngineInterface, id: string): Promise<void> {
  try {
    ensureRuntime($)
    void ensureTick($)
    await enter($)
    await setAuto($, s => dismiss(s, [id]))
    // A repo row: setRepos is the choke point that drops it now that the id is on the dismiss list.
    if (id.startsWith('rp:')) await setRepos($, rows => rows)
    else if (!isRowId(id)) await setItems($, list => list.filter(rec => rec.key !== id)) // the store copy loses it too
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
      items: legacyHost($),
      extraSlots: [reposSlot($), processesSlot($), autoSlot($)],
      global: GLOBAL_DEFAULTS,
    },
    portsOf($),
  )
  return manager
}

function factsOf($: EngineInterface): FactsPort {
  return managerOf($).facts
}

/** The session check: the first step of every hook that reads or writes session data. */
function enter($: EngineInterface): Promise<void> {
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

function reposSlot($: EngineInterface): DataSlot {
  return {
    id: 'repos',
    persist: true,
    read: async () => (await readRepos($)) as unknown as Json,
    empty: isEmpty,
    settle: async (live, stored) =>
      mergeRepoRows(
        (stored ?? []) as unknown as RepoRecord[],
        (live ?? []) as unknown as RepoRecord[],
      ) as unknown as Json,
    restore: async (value, how) => {
      const rows = value as unknown as RepoRecord[]
      if (rows.length > 0)
        await setRepos($, cur => (how === 'carry' ? mergeRepoRows(rows, cur) : mergeRepoRows(cur, rows)))
    },
    clear: () => setRepos($, () => []),
  }
}

function processesSlot($: EngineInterface): DataSlot {
  return {
    id: 'processes',
    persist: true,
    read: async () => (await readProcesses($)) as unknown as Json,
    empty: isEmpty,
    settle: async (live, stored) =>
      mergeProcessRows(
        (stored ?? []) as unknown as ProcessRecord[],
        (live ?? []) as unknown as ProcessRecord[],
      ) as unknown as Json,
    restore: async (value, how) => {
      const rows = value as unknown as ProcessRecord[]
      if (rows.length > 0)
        await setProcesses($, cur => (how === 'carry' ? mergeProcessRows(rows, cur) : mergeProcessRows(cur, rows)))
    },
    clear: () => setProcesses($, () => []),
  }
}

/** The run: root, proofs, agents, dismiss list. Run-scoped: a switch carries it before anything else loads (D9). */
function autoSlot($: EngineInterface): DataSlot {
  return {
    id: 'auto',
    persist: false,
    read: () => portsOf($).state.slot.get('auto'),
    empty: v => v === undefined,
    settle: async live => live,
    restore: async value => {
      const cur = await readAuto($)
      const next = carryAuto(value as unknown as AutoState, cur)
      publishAuto($, next === cur ? cur : await updateAuto($, c => carryAuto(value as unknown as AutoState, c)))
    },
  }
}

/** The part of the item host that this file still holds. Task 11 moves the rest in. */
function legacyHost($: EngineInterface): Pick<ItemsHost, 'slot' | 'sessionChanged'> {
  return {
    slot: itemsSlot($),
    sessionChanged: async () => {
      resetRepo($)
      await publishTools($) // the tools atom was reset too
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
  await arm($)
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

/** The Write, Edit and Read hooks: track the Markdown file, then count the call as a sign of life (A7). */
async function onFileTool($: EngineInterface, tool: string, ran: unknown, agentId: string | undefined): Promise<void> {
  try {
    await arm($)
    const t = touchFromToolResult(tool, ran)
    if (t) await captureFileTouch($, t, agentId)
    await touch($, agentId)
  } catch {
    // Tracking a file must not change the tool result.
  }
}

// ------------------------------------------------------------------ process tracking

function mergeProcessRows(cur: ProcessRecord[], added: ProcessRecord[]): ProcessRecord[] {
  if (added.length === 0) return cur
  const now = Date.now()
  const byId = new Map(cur.map(r => [r.id, r]))
  for (const row of added) {
    const old = byId.get(row.id)
    byId.set(
      row.id,
      old
        ? {
            ...old,
            ...row,
            firstSeen: old.firstSeen,
            lastSeen: now,
          }
        : row,
    )
  }
  return [...byId.values()].sort((a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id))
}

async function addProcessRows($: EngineInterface, rows: ProcessRecord[]): Promise<void> {
  if (rows.length === 0) return
  await setProcesses($, cur => mergeProcessRows(cur, rows))
}

async function applyTaskUpdate(
  $: EngineInterface,
  u: { taskId?: string; toolUseId?: string; state: ProcessRecord['state'] } | null,
): Promise<void> {
  if (!u) return
  await setProcesses($, rows => {
    let changed = false
    const next = rows.map(r => {
      const byTask = u.taskId !== undefined && r.taskId === u.taskId
      const byToolUse = u.toolUseId !== undefined && r.toolUseId === u.toolUseId
      if (!byTask && !byToolUse) return r
      changed = true
      return { ...r, state: u.state, lastSeen: Date.now() }
    })
    return changed ? next : rows
  })
}

/** A probe command ran and exited non-zero. Not a breaker failure. */
class ExitError extends Error {}

async function probeProcesses($: EngineInterface): Promise<void> {
  const run = runCmd
  if (!run) return
  const now = Date.now()
  if (!processBreaker.allows(now)) {
    processUiState = { ...processUiState, breaker: 'open', openUntil: processBreaker.openUntil }
    return
  }
  const rows = await readProcesses($)
  const of = (kind: ProcessRecord['kind']) => rows.filter(r => r.kind === kind)
  const dockerRows = of('docker-container')
  const composeRows = of('docker-compose')
  const tmuxRows = of('tmux')
  const screenRows = of('screen')
  const pidRows = of('detached-process').filter(r => r.pid !== undefined)
  const lostRows = of('detached-process').filter(r => r.pid === undefined && r.fingerprint !== undefined)
  const opts = { timeoutMs: LIMITS.discoveryTimeoutMs }
  const updates = new Map<string, Partial<ProcessRecord>>()
  const mark = (r: ProcessRecord, state: ProcessRecord['state'], pid?: number) => {
    if (r.state === state && (pid === undefined || r.pid === pid)) return
    updates.set(r.id, { state, ...(pid !== undefined ? { pid } : {}) })
  }
  // Each source is probed on its own: a Docker daemon that is down must not stop the tmux probe.
  // A failed source leaves its rows at their last known state. Only a thrown error (timeout, no binary) counts
  // for the breaker. A quick non-zero `docker ps` (daemon down) is shown as the reason and does not open it,
  // else after three ticks the open breaker would stop the tmux, screen and ps probes too.
  const failures: string[] = []
  let dockerError: string | undefined
  const probe = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!(e instanceof ExitError)) failures.push(msg)
      if (what === 'docker') dockerError = msg.includes('ENOENT') ? 'docker not installed' : msg.trim()
    }
  }

  if (dockerRows.length > 0 || composeRows.length > 0)
    await probe('docker', async () => {
      const ps = await run(['docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}'], opts)
      if (ps.exitCode !== 0) throw new ExitError(ps.stderr.trim() || `docker ps failed (${ps.exitCode})`)
      const seen = parseDockerPs(ps.stdout)
      const found = new Map<string, ProcessRecord['state']>()
      for (const r of dockerRows) found.set(r.id, seen.find(x => dockerEntryMatchesRow(x, r))?.state ?? 'exited')
      for (const r of composeRows) {
        const label = `label=com.docker.compose.project=${r.project ?? r.name}`
        const listed = await run(['docker', 'ps', '-a', '--filter', label, '--format', '{{.Status}}'], opts)
        if (listed.exitCode !== 0) throw new ExitError(listed.stderr.trim() || `docker ps failed (${listed.exitCode})`)
        found.set(r.id, composeState(listed.stdout))
      }
      for (const r of [...dockerRows, ...composeRows]) mark(r, found.get(r.id)!)
    })

  if (tmuxRows.length > 0)
    await probe('tmux', async () => {
      const live = new Set(tmuxLive(await run(['tmux', 'ls'], opts)))
      for (const r of tmuxRows) mark(r, live.has(r.name) ? 'running' : 'exited')
    })

  if (screenRows.length > 0)
    await probe('screen', async () => {
      const live = new Set(screenLive(await run(['screen', '-ls'], opts)))
      for (const r of screenRows) mark(r, live.has(r.name) ? 'running' : 'exited')
    })

  if (pidRows.length > 0)
    await probe('ps', async () => {
      for (const r of pidRows) {
        const out = await run(['ps', '-p', String(r.pid), '-o', 'lstart=,command='], opts)
        const alive = out.exitCode === 0 && psStillMatches(out.stdout, r.fingerprint ?? r.name, r.firstSeen)
        mark(r, alive ? 'running' : 'exited')
      }
    })

  // A detached process with no `echo $!` in its Bash call: find it once by command and start time.
  if (lostRows.length > 0)
    await probe('ps', async () => {
      const all = await run(['ps', '-A', '-o', 'pid=,lstart=,command='], opts)
      if (all.exitCode !== 0) throw new Error(all.stderr.trim() || `ps failed (${all.exitCode})`)
      for (const r of lostRows) {
        const pid = findDetachedPid(all.stdout, r.fingerprint!, r.firstSeen)
        mark(r, pid !== undefined ? 'running' : 'exited', pid)
      }
    })

  if (updates.size > 0)
    await setProcesses($, current => {
      const seenNow = Date.now()
      let changed = false
      const merged = current.map(r => {
        const u = updates.get(r.id)
        if (u === undefined || (u.state === r.state && (u.pid === undefined || u.pid === r.pid))) return r
        changed = true
        return { ...r, ...u, lastSeen: seenNow }
      })
      return changed ? merged : current
    })
  if (failures.length > 0) processBreaker.failure(now)
  else processBreaker.success()
  const dockerProbed = dockerRows.length > 0 || composeRows.length > 0
  processUiState = {
    ...processUiState,
    breaker: processBreaker.state,
    openUntil: processBreaker.openUntil,
    dockerIssue: dockerError ?? (dockerProbed ? undefined : processUiState.dockerIssue),
  }
}

// ------------------------------------------------------------------ store

/** A stored copy as read back: the three lists of one session. An older copy may lack one. */
type StoredCopy = Partial<{ items: ItemRecord[]; repos: RepoRecord[]; processes: ProcessRecord[] }>

/** The stored copy of a session, or undefined. */
async function storedCopy($: EngineInterface, id: string): Promise<StoredCopy | undefined> {
  return (await managerOf($).persistence.read(id)) as unknown as StoredCopy | undefined
}

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
 * Items from `$.session.messages()`: a `--resume` load fires no append hooks. File rows come from the Write, Edit
 * and Read results and the mentions, artifact rows from the Artifact tool uses, in transcript order. A subagent's
 * transcript stores no result, so its writes and publishes come back from the stored copy only.
 */
async function fromTranscript($: EngineInterface): Promise<ItemRecord[]> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return []
  // In transcript order, so a delete lands after the publish before it.
  const batches: ({ refs: Ref[]; source: Source } | { deleted: string })[] = []
  const fileRecs: FileRecord[] = []
  const opts = { defaultRepo: sessionRepo ?? null, githubHosts }
  const toolSite = await activeJiraSite()
  const ctx = await fileCtx($)
  const at = Date.now()
  for (const m of messages) {
    const text = backfillText(m.role, m.text)
    const source: Source = m.role === 'user' ? 'prompt' : 'response'
    if (text !== null) {
      batches.push({
        refs: await keepOpenSessionShortRefs(extractRefs(text, { mode: 'full', ...opts, strictShortRefs: true })),
        source,
      })
      fileRecs.push(...(await mentionRecords($, ctx, text, { source, at })))
    }
    for (const use of m.toolUses) {
      const t = touchFromToolResult(use.tool, use)
      const rec = t && (await sighting($, ctx, t.spelled, t.kind, false, { source: 'tool', at }))
      if (rec) fileRecs.push(rec)
      if (use.tool === 'Artifact') {
        const ev = artifactEvent(use.input, use)
        if (ev?.kind === 'published') batches.push({ refs: [ev.ref], source: 'publish' })
        else if (ev?.kind === 'deleted') batches.push({ deleted: ev.key })
      }
      if (!use.text) continue
      const refs = filterToolRefsForSite(extractRefs(use.text, { mode: 'urls-only', ...opts }), toolSite)
      if (refs.length > 0) batches.push({ refs, source: 'tool' })
    }
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
 * The items of a stored copy, then what the transcript adds. A `--resume` load and a /resume switch both come here.
 * The list is empty: the caller checked. Does not wait for the repo, which may need `gh` calls of up to 30 s.
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
  const have = new Map(stored.map(r => [r.key, r]))
  // A stored key wins over the transcript, except for what only the transcript may know of an artifact:
  // a publish or a delete that landed after the last flush.
  const news = (r: ItemRecord): boolean => {
    const old = have.get(r.key)
    if (!old) return true
    if (r.category !== 'artifact' || old.category !== 'artifact') return false
    return (artifactOrigin(r) === 'published' && artifactOrigin(old) === 'mentioned') || (!!r.deleted && !old.deleted)
  }
  const fresh = (await fromTranscript($)).filter(r => news(r) && !dismissed.has(r.key))
  const all = unionRecords(stored, fresh)
  if (all.length === 0) return
  await setItems($, list => unionRecords(list, all))
  void repoReady
    .then(async () => {
      const repo = sessionRepo
      if (repo) await setItems($, list => resolveBareRefs(list, repo))
    })
    .catch(() => {})
  coordinator?.kick('capture')
}

/** Fill the lists again at startup: the stored copy of this session, then what the transcript adds. */
async function restore($: EngineInterface): Promise<void> {
  const live = await read($, items)
  if (live.length > 0) {
    // A hot reload keeps $.state: nothing to restore. Rows an older version stored as web links move (R13).
    if (rekeyArtifacts(live) !== live) await setItems($, rekeyArtifacts)
    return
  }
  // No gate on the index: two sessions that flush together can drop each other's id from it.
  const copy = await storedCopy($, await $.session.id())
  await loadItems($, copy?.items ?? [])
  const repoRows = copy?.repos ?? []
  const proc = copy?.processes ?? []
  if (repoRows.length > 0) await setRepos($, rows => mergeRepoRows(rows, repoRows))
  if (proc.length > 0) await setProcesses($, rows => mergeProcessRows(rows, proc))
}

// ------------------------------------------------------------------ /track

/** The view context from what is known now. It does not wait for the repo: a render must not wait on `gh`. */
async function contextOf($: EngineInterface, bodyColumns?: number): Promise<ViewContext> {
  return {
    now: Date.now(),
    folded: (await read($, ui)).folded,
    tools: viewTools(await read($, tools)),
    sessionRepo,
    auto: await readAuto($),
    ...(lastRoundAt !== undefined ? { autoCheckedAt: lastRoundAt } : {}),
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
    processUiState,
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
    await arm($)
    await setItems($, list => setPriority(list, id, level))
  } catch {
    return // The mark stays. The person can press again.
  }
  try {
    const sections = composePane(await read($, items), await readProcesses($), processUiState, await contextOf($))
    const key = markKeys(sections).get(id)
    if (key !== undefined) await $.ui.focus({ requestId: PANE, key })
  } catch {
    // The ring stays where it is. The next Tab moves it.
  }
}

// ------------------------------------------------------------------ hooks

export const register: Register = on => {
  // The person's typed prompt. Machines and notifications are not the person's text (D3).
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      await enter($) // the first row of a new session carries the old one over, whatever the row is
      if (e.origin.kind === 'task-notification')
        await applyTaskUpdate(
          $,
          processUpdateFromNotification((e as { task?: unknown }).task) ??
            processUpdateFromNotificationText(textOfContent(stored.message?.content)),
        )
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
      await arm($)
      await applyArtifactCall($, e, ran)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  // Once per process: register the command and load what a resume brought in.
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
      ensureRuntime($)
      await enter($) // learns the session id
      await setAuto($, s => pinRoot(s, e.cwd, Date.now())) // A3: a later session.start (reload) keeps the pinned root
    } catch {
      // No root this time. The next session.start pins it.
    }
    try {
      // Old data is dropped by design: the v2 layout starts empty (plan: Behavior changes).
      if (!legacyDropped) {
        legacyDropped = true
        await managerOf($).persistence.dropLegacy()
      }
    } catch {
      // The old keys stay. They cost space only, and the next load tries again.
    }
    try {
      await restore($)
    } catch {
      // The list stays empty. New rows still land.
    }
    await ensureTick($) // A1: from the start, with the pane open or closed
    scheduler?.kick('start')
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
    ensureRuntime($)
    await enter($)
    await ensureTick($)
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
      await probeProcesses($).catch(() => {})
      await openPane($)
      c.kick('open')
      return { text: await listText($) }
    }
    if (arg === 'refresh') {
      await settleProbes($)
      g.reset()
      a.reset()
      scheduler?.kick('manual')
      const run = await c.runDue({ force: true })
      if (run.skipped) {
        // A run was in flight: the forced run is queued behind it. Wait, then publish the tool status again.
        // The publish is also a write of this dispatch. Without it the reads below still show the moment
        // before the runs (`$.state.get` reads one moment for each dispatch).
        await c.idle()
        await publishTools($)
      }
      await scheduler?.idle()
      await round?.idle()
      processBreaker.reset()
      await probeProcesses($).catch(() => {})
      return { text: await listText($) }
    }
    if (arg === 'clear') {
      const ids = autoIds(await readAuto($), await read($, items))
      await setAuto($, s => dismiss(s, ids)) // so the next tick does not bring the auto items back (A14)
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
        await managerOf($).persistence.flushNow() // `claude -p` can exit right after the reply: save now, not after flushMs
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
      processUiState,
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
        void ensureTick($)
        coordinator?.kick('manual')
        scheduler?.kick('manual')
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

  // ---------------------------------------------------------------- auto tracking events (spec 7)

  on('tool.call', { tool: 'EnterWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await arm($)
      const f = fromEnterResult(ran, e.agentId)
      if (f) await setAuto($, s => recordEnter(s, f, Date.now()))
      await touch($, e.agentId)
      kickAuto($, 'worktree')
    } catch {
      // The tool result goes back unchanged.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'ExitWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await arm($)
      await touch($, e.agentId)
      kickAuto($, 'worktree') // the next round marks the child removed (remove) or keeps it live (keep)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await arm($)
      const f = fromAgentResult(ran)
      if (f?.worktreePath !== undefined) await setAuto($, s => recordAgentResult(s, f, Date.now()))
      await touch($, e.agentId)
      kickAuto($, 'agent')
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // The Bash input has no cwd. A compose project without -p is named after a folder, and a relative `cd` or `git -C`
    // needs a base. Read the session's cwd BEFORE the command runs: a persisted `cd` moves it.
    const cwd = (await $.session.cwd().catch(() => undefined)) ?? undefined
    const ran = await next(e)
    const command = String(e.command ?? '')
    try {
      await arm($)
      await addProcessRows($, parseBashProcesses(command, ran, e.tool_use_id, Date.now(), cwd))
      const f = fromBash(command, ran, e.agentId)
      const { agentId, branch } = f
      if (agentId !== undefined && branch !== undefined) await setAuto($, s => recordAgentBranch(s, agentId, branch))
      await touch($, e.agentId)
      if (f.kick) kickAuto($, f.kick)
    } catch {
      // See above.
    }
    try {
      // Last, and not for a denied call. A failing command still touched the repo.
      if (!refused(ran)) {
        const repoHints = parseRepoHintsFromBash(command, repoBaseDir(cwd, e.agentId))
        enqueueRepoPaths($, repoHints.paths, e.agentId)
        enqueueRepoRefs($, repoHints.repos, e.agentId)
      }
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await arm($)
      const taskId =
        ran && typeof ran === 'object' && 'result' in ran && ran.result && typeof ran.result === 'object'
          ? (ran.result as Record<string, unknown>).taskId
          : undefined
      if (typeof taskId === 'string' && taskId !== '')
        await addProcessRows($, [monitorRow(taskId, Date.now(), e.tool_use_id)])
      await touch($, e.agentId)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await arm($)
      const result =
        ran && typeof ran === 'object' && 'result' in ran ? (ran as { result?: unknown }).result : undefined
      await applyTaskUpdate($, processUpdateFromTaskStop(result))
      await touch($, e.agentId)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  // The file tools. A failed or denied call touched nothing. Not a sign of life: only the hooks above are (A7).
  for (const tool of PATH_TOOLS) {
    // The cast: the typings of this engine version do not list Grep and Glob as built-in tools.
    on('tool.call', { tool: tool as 'Read' }, async ($, e, next) => {
      // A relative path needs the session cwd, read before the call runs. Only the main loop has one.
      let hits = extractRepoPathsFromTool(tool, e)
      if (e.agentId === undefined && hits.some(h => !h.path.startsWith('/') && !h.path.startsWith('~'))) {
        const cwd = (await $.session.cwd().catch(() => undefined)) ?? undefined
        hits = extractRepoPathsFromTool(tool, e, repoBaseDir(cwd, e.agentId))
      }
      const ran = await next(e)
      try {
        if (!failed(ran)) {
          await arm($)
          enqueueRepoPaths($, hits, e.agentId)
        }
      } catch {
        // See above.
      }
      return ran
    }).catch((_$, e, next) => next(e))
  }

  // A subagent or a workflow agent starts. `next` gives its id. The master cwd is read before `next`: it is the
  // spawn-time location of a child of the main loop (A6).
  on('agent.spawn', async ($, e, next) => {
    let sessionCwd: string | undefined
    if (e.cwd === undefined && e.parentAgentId === undefined) sessionCwd = await $.session.cwd().catch(() => undefined)
    const out = await next(e)
    try {
      ensureRuntime($)
      await enter($)
      const f = fromSpawn(e, out)
      if (f) {
        const state = await setAuto($, s => recordSpawn(s, f, Date.now(), sessionCwd))
        // A nested child with no cwd of its own works where the ledger put it: in the cwd of its parent.
        const cwd =
          f.cwd ?? (f.parentAgentId !== undefined ? state.agents.find(a => a.id === f.agentId)?.cwd : undefined)
        if (cwd) enqueueRepoPaths($, [{ path: cwd, mode: 'read' }], f.agentId)
      }
      kickAuto($, 'agent')
    } catch {
      // See above.
    }
    return out
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    try {
      ensureRuntime($)
      await enter($)
      void ensureTick($) // a main-loop turn has no agent id and no fact, but it is the most regular beat to re-arm on
      const f = fromTurnEnd(e)
      if (f) {
        const at = Date.now()
        await setAuto($, s => recordTurnEnd(recordActivity(s, f.agentId, at), f.agentId, f.reason, at))
        kickAuto($, 'agent')
      }
    } catch {
      // See above.
    }
    return out
  }).catch((_$, e, next) => next(e))
}

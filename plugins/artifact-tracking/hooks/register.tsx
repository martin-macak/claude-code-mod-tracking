// Wiring for the artifact-tracking mod. The only file that touches `$`.
// Capture hooks observe rows. A coordinator refreshes the items with gh and acli. A pane and a band draw them.
// Specs: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md sections 6 to 10, and
// docs/superpowers/specs/2026-10-10-auto-tracking-design.md (the `auto` atom, the tick, the round, the hooks of spec 7).

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { autoIds, dismiss } from './auto/dismiss'
import { fromAgentResult, fromBash, fromEnterResult, fromSpawn, fromTurnEnd } from './auto/events'
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
} from './auto/ledger'
import { AutoRound } from './auto/round'
import { AutoScheduler } from './auto/scheduler'
import { artifactEvent } from './capture/artifact-tool'
import type {
  AutoReason,
  AutoState,
  DiscoveryApplied,
  FileActivity,
  FileRecord,
  GitHubRef,
  GitHubTarget,
  ItemRecord,
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
import { AUTO_SOURCES, isRowId, LIMITS } from './contracts'
import { isRecord } from './json'
import { dropAuto } from './model/discovered'
import { artifactOrigin, keyOf } from './model/keys'
import {
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
import {
  monitorRow,
  parseBashProcesses,
  processUpdateFromNotification,
  processUpdateFromNotificationText,
  processUpdateFromTaskStop,
} from './process/parse'
import {
  composeState,
  dockerEntryMatchesRow,
  findDetachedPid,
  parseDockerPs,
  psStillMatches,
  screenLive,
  tmuxLive,
} from './process/probe'
import type { Timer } from './refresh/coordinator'
import { RefreshCoordinator } from './refresh/coordinator'
import {
  extractRepoPathsFromTool,
  parseRepoHintsFromBash,
  RepoTracker,
  type RepoVisit,
  upsertRepoRows,
} from './repos/tracker'
import {
  type FileTouch,
  type IgnoreContext,
  isIgnored,
  mdCandidates,
  normalizePath,
  resolvePath,
  touchFromToolResult,
} from './scan/files'
import { textOfContent } from './scan/links'
import { commandArgs, extractRefs, parseRemote } from './scan/refs'
import { AcliTool } from './tools/acli-tool'
import { CircuitBreaker } from './tools/circuit-breaker'
import { GhTool } from './tools/gh-tool'
import { composeBand, composeCommandText, composePane } from './ui/auto-view'
import { renderBand } from './ui/band'
import { renderSections } from './ui/pane'
import type { ViewContext } from './ui/view'

// ------------------------------------------------------------------ state

// Working set in $.state (survives hot reload, reset by /clear). Mirror in $.store, one key per session.
const items = atom({ plugin: 'artifact-tracking', key: 'items' } as const, [] as ItemRecord[])
const repos = atom({ plugin: 'artifact-tracking', key: 'repos' } as const, [] as RepoRecord[])
const processes = atom({ plugin: 'artifact-tracking', key: 'processes' } as const, [] as ProcessRecord[])
const tools = atom(
  { plugin: 'artifact-tracking', key: 'tools' } as const,
  {
    gh: { name: 'gh', available: null, loggedIn: null, breaker: 'closed' },
    acli: { name: 'acli', available: null, loggedIn: null, breaker: 'closed' },
  } as { gh: ToolStatus; acli: ToolStatus },
)
const ui = atom({ plugin: 'artifact-tracking', key: 'ui' } as const, { folded: [], paneOpen: false } as UiState)
/** The run: root, proofs, agents, dismiss list and the last snapshot (spec 6.2). Never goes to $.store. */
const auto = atom({ plugin: 'artifact-tracking', key: 'auto' } as const, emptyAuto() as AutoState)

const PANE = 'track'
const USAGE = 'Usage: /track [refresh|clear]'
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
/** The session id last seen. A change means /clear, /resume or /branch. */
let knownId: string | undefined
let tick: Timer | null = null
let flushTimer: Timer | null = null
/** `$.clock.now()` when `flushTimer` was armed. */
let flushArmedAt = 0
/**
 * The list as last written for `knownId`. A module variable outlives /clear, `$.state` does not.
 * So a /clear still finds what was captured in the last moments (D10).
 */
let mirror: { id: string; items: ItemRecord[] } | undefined
let repoMirror: { id: string; rows: RepoRecord[] } | undefined
let processMirror: { id: string; rows: ProcessRecord[] } | undefined
let scheduler: AutoScheduler | undefined
let round: AutoRound | undefined
/** `$.clock.now()` when the tick was armed, and at each beat (A1). */
let lastBeatAt = 0
/** The `auto` atom as last written. A module variable outlives /clear, `$.state` does not (A18). */
let autoMirror: AutoState | undefined
/** When the last round ended. The Worktrees note reads it before `snapshot.at` (A22). */
let lastRoundAt: number | undefined
/** The last list written to $.store: id and JSON. A flush of an equal list writes nothing (A22). */
let flushed: { id: string; json: string } | undefined
let repoTracker: RepoTracker | undefined

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
      return autoMirror?.root?.top ?? (typeof autoMirror?.root?.cwd === 'string' ? autoMirror.root.cwd : undefined)
    },
    get rootRepo() {
      return sessionRepo ?? null
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
      const s = await currentAuto($)
      autoMirror = s
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
const shown = (x: { gh: ToolStatus; acli: ToolStatus }): string =>
  JSON.stringify([
    { ...x.gh, lastRunAt: undefined },
    { ...x.acli, lastRunAt: undefined },
  ])

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

/** Change the list in $.state and remember the result in `mirror`. Every write to `items` goes through here. */
async function setItems($: EngineInterface, change: (list: ItemRecord[]) => ItemRecord[]): Promise<void> {
  const next = await update($, items, list => change(list ?? []))
  const id = await $.session.id()
  // A write that lands after /clear but before the id change is seen belongs to the old session. Keep the old mirror.
  if (knownId !== undefined && id === knownId) mirror = { id, items: next }
}

/** Like setItems, for tracked repositories. */
async function setRepos($: EngineInterface, change: (rows: RepoRecord[]) => RepoRecord[]): Promise<void> {
  const next = await update($, repos, rows => change(rows ?? []))
  const id = await $.session.id()
  if (knownId !== undefined && id === knownId) repoMirror = { id, rows: next }
  await schedule($)
}

/** Like setItems, for tracked background processes. */
async function setProcesses($: EngineInterface, change: (rows: ProcessRecord[]) => ProcessRecord[]): Promise<void> {
  const next = await update($, processes, rows => change(rows ?? []))
  const id = await $.session.id()
  if (knownId !== undefined && id === knownId) processMirror = { id, rows: next }
  await schedule($)
}

/**
 * Change the `auto` atom. Every write goes through here (A18, A22). It reads first and stops when the change
 * returns its input: no write. Else `update` runs the change on the current value, with the module copy as the
 * fallback after /clear, and retries on a version miss.
 */
async function setAuto($: EngineInterface, change: (cur: AutoState) => AutoState): Promise<AutoState> {
  const cur = await read($, auto)
  if (change(carryAuto(autoMirror, cur)) === cur) {
    autoMirror = cur
    return cur
  }
  const next = await update($, auto, c => change(carryAuto(autoMirror, c)))
  autoMirror = next
  return next
}

/** The `auto` atom, or the module copy when /clear reset it. */
async function currentAuto($: EngineInterface): Promise<AutoState> {
  return carryAuto(autoMirror, await read($, auto))
}

/**
 * The item write of a round. `change` also gets the dismiss list, read inside the change from `autoMirror` (A20).
 * Reads first and skips `update` when the change returns the input list itself (A22).
 * Like `capture`, it looks at the session id first: a PR step that was in flight over /resume must not fill the new,
 * empty list before `restore` has loaded the stored copy.
 */
async function applyItems(
  $: EngineInterface,
  change: (list: ItemRecord[], dismissed: ReadonlySet<string>) => DiscoveryApplied,
): Promise<DiscoveryApplied> {
  await ensureSession($)
  const dismissed = (): ReadonlySet<string> => new Set((autoMirror ?? emptyAuto()).dismissed)
  const cur = await read($, items)
  let result = change(cur, dismissed())
  if (result.list === cur) return result
  await setItems($, list => {
    result = change(list, dismissed())
    return result.list
  })
  return result
}

/** A sign of life for a workflow agent (A7). A main-loop call has no agent id and does nothing. */
async function touch($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId !== undefined) await setAuto($, s => recordActivity(s, agentId, Date.now()))
}

function touchedBy(agentId: string | undefined): string {
  if (agentId === undefined) return 'main'
  const label = autoMirror?.agents.find(a => a.id === agentId)?.label
  return label && label !== '' ? label : `agent:${agentId.slice(0, 8)}`
}

async function trackRepoPaths(
  $: EngineInterface,
  paths: readonly string[],
  agentId: string | undefined,
): Promise<void> {
  const tracker = repoTracker
  if (!tracker || paths.length === 0) return
  const who = touchedBy(agentId)
  const at = Date.now()
  const visits = (
    await Promise.all(
      paths.map(async path => {
        try {
          return await tracker.resolvePath(path, who)
        } catch {
          return null
        }
      }),
    )
  ).filter(x => x !== null)
  if (visits.length === 0) return
  await setRepos($, rows => {
    let out = rows
    for (const v of visits) out = upsertRepoRows(out, { ...v, at })
    return out
  })
}

async function trackRepoRefs($: EngineInterface, refs: readonly RepoRef[], agentId: string | undefined): Promise<void> {
  const tracker = repoTracker
  if (!tracker || refs.length === 0) return
  const who = touchedBy(agentId)
  const at = Date.now()
  const visits: RepoVisit[] = []
  for (const ref of refs) {
    try {
      const v = await tracker.fromRepoRef(ref, who)
      if (v) visits.push(v)
    } catch {
      // one bad ref must not stop the others
    }
  }
  if (visits.length === 0) return
  await setRepos($, rows => {
    let out = rows
    for (const v of visits) out = upsertRepoRows(out, { ...v, at })
    return out
  })
}

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
    await ensureSession($)
    await ensureRepo($)
  } catch {
    // The beat still kicks what it can.
  }
  scheduler?.kick('tick')
  coordinator?.kick('tick')
  await probeProcesses($).catch(() => {})
}

/** Builds the runtime if needed and looks at the tick. The first step of every event hook. */
function arm($: EngineInterface): void {
  ensureRuntime($)
  void ensureTick($)
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
    await setAuto($, s => dismiss(s, [id]))
    if (!isRowId(id)) await setItems($, list => list.filter(rec => rec.key !== id))
  } catch {
    // The row stays. The person can press again.
  }
}

// ------------------------------------------------------------------ session id and repo

/**
 * /clear, /resume and /branch give a new id and reset $.state, and `session.start` does not fire again.
 * So compare the id on every use: in each hook, in the tick and in the flush. On a change:
 * 1. Save the last list of the session just left. Its flush may not have run (D10).
 * 2. A new id that the store knows is a /resume: restore that session (its copy, then the transcript).
 * 3. Any other new id is a /clear or a /branch: carry the items of the old session over.
 */
async function ensureSession($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if (knownId === id) return
  const prev = knownId
  knownId = id
  sessionRepo = undefined
  repoTask = undefined
  if (prev === undefined) return
  // The `auto` atom belongs to the run, not to a session id. After /clear $.state is empty; the module copy fills it.
  await setAuto($, s => s)
  const stored = (await $.store.get('s:' + prev)) as
    | { items?: ItemRecord[]; repos?: RepoRecord[]; processes?: ProcessRecord[] }
    | undefined
  const held = mirror?.id === prev ? mirror.items : []
  const heldRepos = repoMirror?.id === prev ? repoMirror.rows : []
  const heldProc = processMirror?.id === prev ? processMirror.rows : []
  mirror = undefined
  repoMirror = undefined
  processMirror = undefined
  const left = rekeyArtifacts(unionRecords(held, stored?.items ?? []))
  const leftRepos = mergeRepoRows(stored?.repos ?? [], heldRepos)
  const leftProc = mergeProcessRows(stored?.processes ?? [], heldProc)
  if (held.length > 0 || heldRepos.length > 0 || heldProc.length > 0)
    await writeStore($, prev, left, leftRepos, leftProc)
  const own = (await $.store.get('s:' + id)) as
    | { items?: ItemRecord[]; repos?: RepoRecord[]; processes?: ProcessRecord[] }
    | undefined
  if (own?.items || own?.repos || own?.processes) {
    await restore($)
  } else if (left.length > 0) {
    await setItems($, list => unionRecords(left, list))
    if (leftRepos.length > 0) await setRepos($, rows => mergeRepoRows(leftRepos, rows))
    if (leftProc.length > 0) await setProcesses($, rows => mergeProcessRows(leftProc, rows))
  } else if (leftRepos.length > 0) {
    await setRepos($, rows => mergeRepoRows(leftRepos, rows))
    if (leftProc.length > 0) await setProcesses($, rows => mergeProcessRows(leftProc, rows))
  } else if (leftProc.length > 0) {
    await setProcesses($, rows => mergeProcessRows(leftProc, rows))
  }
  await publishTools($) // the tools atom was reset too
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
  arm($)
  await ensureSession($)
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
  const dismissed = new Set((await currentAuto($)).dismissed)
  const keep = refs.filter(ref => !dismissed.has(keyOf(ref)))
  if (keep.length === 0) return
  let added: string[] = []
  await setItems($, list => {
    const merged = mergeRefs(list, keep, { source, at: Date.now() })
    added = merged.added
    return merged.list
  })
  if (added.length > 0) coordinator?.kick('capture', added)
  await schedule($)
}

/**
 * An Artifact tool call (issue #29). A publish tracks the page with source `publish`. A delete marks its row;
 * a dismissed or unknown artifact gets no row. Errors, refusals and other actions change nothing.
 */
async function applyArtifactCall($: EngineInterface, input: unknown, ran: unknown): Promise<void> {
  const ev = artifactEvent(input, ran)
  if (!ev) return
  await ensureSession($)
  if (ev.kind === 'published') return trackRefs($, [ev.ref], 'publish')
  const cur = await read($, items)
  if (markArtifactDeleted(cur, ev.key) === cur) return // no such row: a write would change nothing (A22)
  await setItems($, list => markArtifactDeleted(list, ev.key))
  await schedule($)
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
  const auto = await currentAuto($)
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
  const dismissed = new Set((await currentAuto($)).dismissed)
  const wanted = recs.filter(r => !dismissed.has(r.key))
  if (withoutLoneViews(await read($, items), wanted).length === 0) return // only views of untracked files: no write
  await setItems($, list => mergeFiles(list, withoutLoneViews(list, wanted)))
  await schedule($)
}

/** A Write, Edit or Read result: one sighting of the file it touched. */
async function captureFileTouch($: EngineInterface, t: FileTouch, agentId: string | undefined): Promise<void> {
  await ensureSession($)
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
    arm($)
    const t = touchFromToolResult(tool, ran)
    if (t) await captureFileTouch($, t, agentId)
    await touch($, agentId)
  } catch {
    // Tracking a file must not change the tool result.
  }
}

// ------------------------------------------------------------------ process tracking

function mergeRepoRows(cur: RepoRecord[], added: RepoRecord[]): RepoRecord[] {
  if (added.length === 0) return cur
  let out = cur
  for (const row of added)
    out = upsertRepoRows(out, { ...row, touchedBy: row.touchedBy[0] ?? 'main', at: row.lastSeen })
  // Carry every touching agent, not only the first one.
  for (const row of added) {
    out = out.map(r => (r.key !== row.key ? r : { ...r, touchedBy: [...new Set([...r.touchedBy, ...row.touchedBy])] }))
  }
  return out
}

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
  const rows = await read($, processes)
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

// ------------------------------------------------------------------ store mirror

/**
 * Copy the list to $.store later. Many rows in one burst make one write.
 * A timer that a hook refused never runs. So a pending timer that is long overdue is replaced.
 * Never rejects.
 */
async function schedule($: EngineInterface): Promise<void> {
  try {
    if (flushTimer) {
      const now = await $.clock.now()
      if (flushTimer && now - flushArmedAt <= 2 * LIMITS.flushMs) return
      flushTimer?.cancel()
      flushTimer = null
    }
    const timer: Timer = $.clock.after(LIMITS.flushMs, async () => {
      if (flushTimer === timer) flushTimer = null
      try {
        await flush($)
      } catch {
        // A failed copy is retried by the next change.
      }
    })
    flushTimer = timer
    flushArmedAt = await $.clock.now()
  } catch {
    // No copy this time. The next change tries again.
  }
}

async function flush($: EngineInterface): Promise<void> {
  await ensureSession($) // a /clear since the last row: save the old session first, carry its items over
  const list = await read($, items)
  const repoRows = await read($, repos)
  const rows = await read($, processes)
  if (list.length === 0 && repoRows.length === 0 && rows.length === 0) return // after /track clear: never replace a stored copy with an empty one
  await writeStore($, await $.session.id(), list, repoRows, rows)
}

/** One session's copy, the index of copies (newest first) and the cap on how many copies stay. */
async function writeStore(
  $: EngineInterface,
  id: string,
  list: ItemRecord[],
  repoRows: RepoRecord[] = [],
  rows: ProcessRecord[] = [],
): Promise<void> {
  const json = JSON.stringify([list, repoRows, rows])
  if (flushed?.id === id && flushed.json === json) return
  await $.store.set('s:' + id, { items: list, repos: repoRows, processes: rows })
  const index = ((await $.store.get('index')) as string[] | undefined) ?? []
  const next = [id, ...index.filter(x => x !== id)]
  for (const old of next.slice(LIMITS.keepSessions)) await $.store.delete('s:' + old)
  await $.store.set('index', next.slice(0, LIMITS.keepSessions))
  flushed = { id, json }
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

/** Fill the list again at startup: the stored copy of this session, then what the transcript adds. */
async function restore($: EngineInterface): Promise<void> {
  const live = await read($, items)
  if (live.length > 0) {
    // A hot reload keeps $.state: nothing to restore. Rows an older version stored as web links move (R13).
    if (rekeyArtifacts(live) !== live) await setItems($, rekeyArtifacts)
    return
  }
  // Do not wait for the repo: it may need `gh` calls of up to 30 s. Bare #N is re-keyed when it arrives.
  const repoReady = ensureRepo($).catch(() => {})
  const id = await $.session.id()
  // No gate on the index: two sessions that flush together can drop each other's id from it.
  const copy = (await $.store.get('s:' + id)) as
    | { items?: ItemRecord[]; repos?: RepoRecord[]; processes?: ProcessRecord[] }
    | undefined
  const activeSite = await activeJiraSite()
  const dismissed = new Set((autoMirror ?? emptyAuto()).dismissed)
  const stored = withoutAuto(rekeyArtifacts(copy?.items ?? []))
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
  const repoRows = copy?.repos ?? []
  const proc = copy?.processes ?? []
  if (all.length === 0 && repoRows.length === 0 && proc.length === 0) return
  if (all.length > 0) await setItems($, list => unionRecords(list, all))
  if (repoRows.length > 0) await setRepos($, rows => mergeRepoRows(rows, repoRows))
  if (proc.length > 0) await setProcesses($, rows => mergeProcessRows(rows, proc))
  void repoReady
    .then(async () => {
      const repo = sessionRepo
      if (repo) await setItems($, list => resolveBareRefs(list, repo))
    })
    .catch(() => {})
  coordinator?.kick('capture')
  await schedule($)
}

// ------------------------------------------------------------------ /track

/** The view context from what is known now. It does not wait for the repo: a render must not wait on `gh`. */
async function contextOf($: EngineInterface, bodyColumns?: number): Promise<ViewContext> {
  return {
    now: Date.now(),
    folded: (await read($, ui)).folded,
    tools: await read($, tools),
    sessionRepo,
    auto: await currentAuto($),
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
    await read($, processes),
    processUiState,
    await viewContext($),
    await read($, repos),
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
  await update($, ui, u => ({ folded: u?.folded ?? [], paneOpen: true }))
}

async function clearAll($: EngineInterface): Promise<void> {
  flushed = undefined
  await setItems($, () => [])
  await setRepos($, () => [])
  await setProcesses($, () => [])
  const id = await $.session.id()
  await $.store.delete('s:' + id)
  const index = ((await $.store.get('index')) as string[] | undefined) ?? []
  await $.store.set(
    'index',
    index.filter(x => x !== id),
  )
}

// ------------------------------------------------------------------ hooks

export const register: Register = on => {
  // The person's typed prompt. Machines and notifications are not the person's text (D3).
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    try {
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
      arm($)
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
        argumentHint: '[refresh|clear]',
      })
    } catch {
      // The command may be refused. Capture and restore still work.
    }
    try {
      ensureRuntime($)
      knownId = await $.session.id()
      await setAuto($, s => pinRoot(s, e.cwd, Date.now())) // A3: a later session.start (reload) keeps the pinned root
    } catch {
      // No root this time. The next session.start pins it.
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

  on('command.run', { command: 'track' }, async ($, e) => {
    ensureRuntime($)
    await ensureSession($)
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
      const ids = autoIds(await currentAuto($), await read($, items))
      await setAuto($, s => dismiss(s, ids)) // so the next tick does not bring the auto items back (A14)
      await clearAll($)
      return { text: 'Tracking list cleared.' }
    }
    return { text: USAGE }
  }).catch(() => ({ text: 'artifact-tracking: could not run the command.' }))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    try {
      await update($, ui, u => ({ folded: u?.folded ?? [], paneOpen: false }))
    } catch {
      // Closing must not fail.
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const list = await read($, items)
    const sections = composePane(
      list,
      await read($, processes),
      processUiState,
      await contextOf($, e.props.bodyColumns),
      await read($, repos),
    )
    return renderSections(el, sections, e.props.bodyColumns, {
      fold: id => {
        void update($, ui, u => {
          const folded = u?.folded ?? []
          return {
            folded: folded.includes(id) ? folded.filter(x => x !== id) : [...folded, id],
            paneOpen: u?.paneOpen ?? true,
          }
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
    })
  }).catch(($, e) => {
    // A failed read must not close the pane. Draw one line instead.
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Tracking is unavailable. Run /track to try again.</Text>
  })

  // One line above the prompt. The engine's own band stays inside our Box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = composeBand(await read($, items), await read($, processes), await currentAuto($), await read($, repos))
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
      arm($)
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
      arm($)
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
      arm($)
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
    const ran = await next(e)
    try {
      arm($)
      const command = String(e.command ?? '')
      // The Bash input has no cwd. A compose project without -p is named after a folder, so read the session's.
      const wantsCwd = /compose|\bcd\b|\bgit\s+-C\b/.test(command)
      const cwd = wantsCwd ? await $.session.cwd().catch(() => undefined) : undefined
      await addProcessRows($, parseBashProcesses(command, ran, e.tool_use_id, Date.now(), cwd ?? undefined))
      const repoHints = parseRepoHintsFromBash(command, cwd ?? undefined)
      await trackRepoPaths($, repoHints.paths, e.agentId)
      await trackRepoRefs($, repoHints.repos, e.agentId)
      const f = fromBash(String(e.command ?? ''), ran, e.agentId)
      const { agentId, branch } = f
      if (agentId !== undefined && branch !== undefined) await setAuto($, s => recordAgentBranch(s, agentId, branch))
      await touch($, e.agentId)
      if (f.kick) kickAuto($, f.kick)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      arm($)
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
      arm($)
      const result =
        ran && typeof ran === 'object' && 'result' in ran ? (ran as { result?: unknown }).result : undefined
      await applyTaskUpdate($, processUpdateFromTaskStop(result))
      await touch($, e.agentId)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const tool = (e as { tool?: string }).tool
      if (!tool) return ran
      arm($)
      await trackRepoPaths($, extractRepoPathsFromTool(tool, e), e.agentId)
      await touch($, e.agentId)
    } catch {
      // See above.
    }
    return ran
  }).catch((_$, e, next) => next(e))

  // A subagent or a workflow agent starts. `next` gives its id. The master cwd is read before `next`: it is the
  // spawn-time location of a child of the main loop (A6).
  on('agent.spawn', async ($, e, next) => {
    let sessionCwd: string | undefined
    if (e.cwd === undefined && e.parentAgentId === undefined) sessionCwd = await $.session.cwd().catch(() => undefined)
    const out = await next(e)
    try {
      ensureRuntime($)
      const f = fromSpawn(e, out)
      if (f) {
        await setAuto($, s => recordSpawn(s, f, Date.now(), sessionCwd))
        if (f.cwd) await trackRepoPaths($, [f.cwd], f.agentId)
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

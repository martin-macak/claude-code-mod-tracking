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
import type {
  AutoReason,
  AutoState,
  DiscoveryApplied,
  ItemRecord,
  Ref,
  RepoRef,
  Runner,
  ScanMode,
  Source,
  ToolStatus,
  UiState,
} from './contracts'
import { AUTO_SOURCES, isRowId, LIMITS } from './contracts'
import { dropAuto } from './model/discovered'
import { keyOf } from './model/keys'
import { hydrate, mergeRefs, mergeResults, resolveBareRefs, unionRecords } from './model/registry'
import type { Timer } from './refresh/coordinator'
import { RefreshCoordinator } from './refresh/coordinator'
import { textOfContent } from './scan/links'
import { commandArgs, extractRefs, parseRemote } from './scan/refs'
import { AcliTool } from './tools/acli-tool'
import { GhTool } from './tools/gh-tool'
import { composeBand, composeCommandText, composePane } from './ui/auto-view'
import { renderBand } from './ui/band'
import { renderSections } from './ui/pane'
import type { ViewContext } from './ui/view'

// ------------------------------------------------------------------ state

// Working set in $.state (survives hot reload, reset by /clear). Mirror in $.store, one key per session.
const items = atom({ plugin: 'artifact-tracking', key: 'items' } as const, [] as ItemRecord[])
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

// ------------------------------------------------------------------ runtime

/** Builds the tools and the coordinator once. `$` only appears in calls, never as a value. */
function ensureRuntime($: EngineInterface): void {
  if (gh && acli && coordinator && scheduler && round) return
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
      let dropped: string[] = []
      await setItems($, list => {
        const merged = mergeResults(list, refreshed)
        const kept = new Set(merged.map(rec => rec.key))
        dropped = list.filter(rec => !kept.has(rec.key)).map(rec => rec.key)
        return merged
      })
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
  const stored = (await $.store.get('s:' + prev)) as { items?: ItemRecord[] } | undefined
  const held = mirror?.id === prev ? mirror.items : []
  mirror = undefined
  const left = unionRecords(held, stored?.items ?? [])
  if (held.length > 0) await writeStore($, prev, left)
  const own = (await $.store.get('s:' + id)) as { items?: ItemRecord[] } | undefined
  if (own?.items) {
    await restore($)
  } else if (left.length > 0) {
    await setItems($, list => unionRecords(left, list))
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
  ensureRuntime($)
  void ensureTick($)
  await ensureSession($)
  await ensureRepo($)
  let refs = extractRefs(text, { mode, defaultRepo: sessionRepo ?? null, githubHosts })
  if (source === 'tool' && mode === 'urls-only') refs = await filterToolRefs(refs)
  const dismissed = new Set((await currentAuto($)).dismissed)
  refs = refs.filter(ref => !dismissed.has(keyOf(ref)))
  if (refs.length === 0) return
  let added: string[] = []
  await setItems($, list => {
    const r = mergeRefs(list, refs, { source, at: Date.now() })
    added = r.added
    return r.list
  })
  if (added.length > 0) coordinator?.kick('capture', added)
  await schedule($)
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
  if (list.length === 0) return // after /track clear: never replace a stored copy with an empty one
  await writeStore($, await $.session.id(), list)
}

/** One session's copy, the index of copies (newest first) and the cap on how many copies stay. */
async function writeStore($: EngineInterface, id: string, list: ItemRecord[]): Promise<void> {
  const json = JSON.stringify(list)
  if (flushed?.id === id && flushed.json === json) return
  await $.store.set('s:' + id, { items: list })
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

/** Items from `$.session.messages()`: a `--resume` load fires no append hooks. */
async function fromTranscript($: EngineInterface): Promise<ItemRecord[]> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return []
  const batches: { refs: Ref[]; source: Source }[] = []
  const opts = { defaultRepo: sessionRepo ?? null, githubHosts }
  const toolSite = await activeJiraSite()
  for (const m of messages) {
    const text = backfillText(m.role, m.text)
    if (text !== null)
      batches.push({
        refs: extractRefs(text, { mode: 'full', ...opts }),
        source: m.role === 'user' ? 'prompt' : 'response',
      })
    for (const use of m.toolUses) {
      if (!use.text) continue
      const refs = filterToolRefsForSite(extractRefs(use.text, { mode: 'urls-only', ...opts }), toolSite)
      if (refs.length > 0) batches.push({ refs, source: 'tool' })
    }
  }
  let list: ItemRecord[] = []
  const at = Date.now()
  for (const b of batches) if (b.refs.length > 0) list = mergeRefs(list, b.refs, { source: b.source, at }).list
  return list
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
  if ((await read($, items)).length > 0) return // a hot reload keeps $.state; nothing to restore
  // Do not wait for the repo: it may need `gh` calls of up to 30 s. Bare #N is re-keyed when it arrives.
  const repoReady = ensureRepo($).catch(() => {})
  const id = await $.session.id()
  // No gate on the index: two sessions that flush together can drop each other's id from it.
  const copy = (await $.store.get('s:' + id)) as { items?: ItemRecord[] } | undefined
  const activeSite = await activeJiraSite()
  const dismissed = new Set((autoMirror ?? emptyAuto()).dismissed)
  const stored = withoutAuto(copy?.items ?? [])
    .filter(rec => keepStored(rec, activeSite))
    .filter(rec => rec.error?.kind !== 'not-found')
    .filter(rec => !dismissed.has(rec.key))
    .map(due)
  const have = new Set(stored.map(r => r.key))
  const fresh = (await fromTranscript($)).filter(r => !have.has(r.key) && !dismissed.has(r.key))
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
  return composeCommandText(await read($, items), await viewContext($))
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

  // Once per process: register the command and load what a resume brought in.
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'track',
        description: 'Show tracked GitHub, Jira and web links',
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
    const sections = composePane(list, await contextOf($, e.props.bodyColumns))
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
    const text = composeBand(await read($, items), await currentAuto($))
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

  // A subagent or a workflow agent starts. `next` gives its id. The master cwd is read before `next`: it is the
  // spawn-time location of a child of the main loop (A6).
  on('agent.spawn', async ($, e, next) => {
    let sessionCwd: string | undefined
    if (e.cwd === undefined && e.parentAgentId === undefined) sessionCwd = await $.session.cwd().catch(() => undefined)
    const out = await next(e)
    try {
      ensureRuntime($)
      const f = fromSpawn(e, out)
      if (f) await setAuto($, s => recordSpawn(s, f, Date.now(), sessionCwd))
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

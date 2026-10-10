// Wiring for the artifact-tracking mod. The only file that touches `$`.
// Capture hooks observe rows. A coordinator refreshes the items with gh and acli. A pane and a band draw them.
// Spec: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md sections 6 to 10.

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { ItemRecord, Ref, RepoRef, Runner, ScanMode, Source, ToolStatus, UiState } from './contracts'
import { LIMITS } from './contracts'
import { hydrate, mergeRefs, mergeResults, resolveBareRefs, unionRecords } from './model/registry'
import type { Timer } from './refresh/coordinator'
import { RefreshCoordinator } from './refresh/coordinator'
import { textOfContent } from './scan/links'
import { commandArgs, extractRefs, parseRemote } from './scan/refs'
import { AcliTool } from './tools/acli-tool'
import { GhTool } from './tools/gh-tool'
import { renderBand } from './ui/band'
import { renderPane } from './ui/pane'
import type { ViewContext } from './ui/view'
import { bandText, buildPane, columnsFor, commandText } from './ui/view'

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
      await setItems($, list => mergeResults(list, refreshed))
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

/** Copies the tool statuses to $.state for the pane. Skips the write when nothing changed. */
async function publishTools($: EngineInterface): Promise<void> {
  const g = gh
  const a = acli
  if (!g || !a) return
  const next = { gh: g.status(), acli: a.status() }
  await update($, tools, cur => (JSON.stringify(cur) === JSON.stringify(next) ? (cur as typeof next) : next))
}

/** Change the list in $.state and remember the result in `mirror`. Every write to `items` goes through here. */
async function setItems($: EngineInterface, change: (list: ItemRecord[]) => ItemRecord[]): Promise<void> {
  const next = await update($, items, list => change(list ?? []))
  const id = await $.session.id()
  // A write that lands after /clear but before the id change is seen belongs to the old session. Keep the old mirror.
  if (knownId !== undefined && id === knownId) mirror = { id, items: next }
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
  await ensureSession($)
  await ensureRepo($)
  const refs = extractRefs(text, { mode, defaultRepo: sessionRepo ?? null, githubHosts })
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
  await $.store.set('s:' + id, { items: list })
  const index = ((await $.store.get('index')) as string[] | undefined) ?? []
  const next = [id, ...index.filter(x => x !== id)]
  for (const old of next.slice(LIMITS.keepSessions)) await $.store.delete('s:' + old)
  await $.store.set('index', next.slice(0, LIMITS.keepSessions))
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
  for (const m of messages) {
    const text = backfillText(m.role, m.text)
    if (text !== null)
      batches.push({
        refs: extractRefs(text, { mode: 'full', ...opts }),
        source: m.role === 'user' ? 'prompt' : 'response',
      })
    for (const use of m.toolUses) {
      if (use.text) batches.push({ refs: extractRefs(use.text, { mode: 'urls-only', ...opts }), source: 'tool' })
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

/** Fill the list again at startup: the stored copy of this session, then what the transcript adds. */
async function restore($: EngineInterface): Promise<void> {
  if ((await read($, items)).length > 0) return // a hot reload keeps $.state; nothing to restore
  // Do not wait for the repo: it may need `gh` calls of up to 30 s. Bare #N is re-keyed when it arrives.
  const repoReady = ensureRepo($).catch(() => {})
  const id = await $.session.id()
  // No gate on the index: two sessions that flush together can drop each other's id from it.
  const copy = (await $.store.get('s:' + id)) as { items?: ItemRecord[] } | undefined
  const stored = (copy?.items ?? []).map(due)
  const have = new Set(stored.map(r => r.key))
  const fresh = (await fromTranscript($)).filter(r => !have.has(r.key))
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

async function viewContext($: EngineInterface): Promise<ViewContext> {
  await ensureRepo($)
  return { now: Date.now(), folded: (await read($, ui)).folded, tools: await read($, tools), sessionRepo }
}

async function listText($: EngineInterface): Promise<string> {
  return commandText(await read($, items), await viewContext($))
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
  startTick($)
}

/**
 * The 30 s tick. It also checks the session id: after /clear no hook may run for a long time,
 * and the open pane would stay empty (D10).
 */
function startTick($: EngineInterface): void {
  tick ??= $.clock.every(LIMITS.tickMs, async () => {
    try {
      ensureRuntime($)
      await ensureSession($)
      // /clear forgets the session repo. Find it again, so the pane keeps short `#N` keys.
      await ensureRepo($)
    } catch {
      // The tick still refreshes what it can.
    }
    coordinator?.kick('tick')
  })
}

async function clearAll($: EngineInterface): Promise<void> {
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
      await restore($)
    } catch {
      // The list stays empty. New rows still land.
    }
    try {
      // A reload keeps the pane open but drops our timers. Start the tick again.
      if ((await $.ui.panes()).some(p => p.id === PANE)) startTick($)
    } catch {
      // No tick until the pane is opened again.
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'track' }, async ($, e) => {
    ensureRuntime($)
    await ensureSession($)
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
      const run = await c.runDue({ force: true })
      if (run.skipped) {
        // A run was in flight: the forced run is queued behind it. Wait, then publish the tool status again.
        // The publish is also a write of this dispatch. Without it the reads below still show the moment
        // before the runs (`$.state.get` reads one moment for each dispatch).
        await c.idle()
        await publishTools($)
      }
      return { text: await listText($) }
    }
    if (arg === 'clear') {
      await clearAll($)
      return { text: 'Tracking list cleared.' }
    }
    return { text: USAGE }
  }).catch(() => ({ text: 'artifact-tracking: could not run the command.' }))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    try {
      await update($, ui, u => ({ folded: u?.folded ?? [], paneOpen: false }))
      tick?.cancel()
      tick = null
    } catch {
      // Closing must not fail.
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const list = await read($, items)
    const state = await read($, ui)
    const sections = buildPane(list, {
      now: Date.now(),
      folded: state.folded,
      tools: await read($, tools),
      sessionRepo,
    })
    return renderPane(el, sections, columnsFor(e.props.bodyColumns), {
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
        coordinator?.kick('manual')
      },
    })
  }).catch(($, e) => {
    // A failed read must not close the pane. Draw one line instead.
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Tracking is unavailable. Run /track to try again.</Text>
  })

  // One line above the prompt. The engine's own band stays inside our Box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = bandText(await read($, items))
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
}

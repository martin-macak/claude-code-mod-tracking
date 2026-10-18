// Wiring for the artifact-tracking mod. The only file that touches `$`.
// Capture hooks observe rows. A coordinator refreshes the items with gh and acli. A pane and a band draw them.
// Specs: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md sections 6 to 10, and
// docs/superpowers/specs/2026-10-10-auto-tracking-design.md (the `auto` atom, the tick, the round, the hooks of spec 7).

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { GLOBAL_DEFAULTS } from '../core/infra/global-defaults'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { Claim, ItemStorePort, Json, StoredItem } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import type { FactsPort } from '../core/interfaces/tracker'
import { buildTrackers } from '../trackers'
import { artifactEvent } from '../trackers/artifact/artifact-tool'
import { autoDismiss } from '../trackers/auto/dismiss-store'
import { emptyAuto } from '../trackers/auto/ledger'
import { renderBand } from '../ux/band'
import { renderSections } from '../ux/pane'
import type {
  AutoState,
  ItemRecord,
  Priority,
  ProcessRecord,
  ProcessUiState,
  RepoRecord,
  ToolStatus,
  UiState,
} from './contracts'
import { rowEvent, spawnEvent, toolCallEvent, turnEvent } from './events'
import { ItemRuntime } from './items/runtime'
import { markArtifactDeleted } from './model/registry'
import { parseRemote } from './scan/refs'
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

// Module state. A hot reload loses it. Each part is rebuilt on the next use.
/** The item host of this load: the list, the capture funnel, the refresh coordinator, the tools, the session repo. */
let runtime: ItemRuntime | undefined
/** The session switch, the store and the facts of this load. Built on first use; a hot reload builds a new one. */
let manager: LifecycleManager | undefined
/** The row the priority keys act on. Never stored: a close, a reload or /clear forgets it. */
let focusedRow: string | undefined
/** Element key to row id, for the Buttons of the rows with a prio cell as last drawn (`focusTargets`). */
let focusRows: ReadonlyMap<string, string> = new Map()

// ------------------------------------------------------------------ the item runtime and the manager

/** The item runtime of this load. It gets the state atoms it writes; everything else comes from the manager's start. */
function runtimeOf($: EngineInterface): ItemRuntime {
  runtime ??= new ItemRuntime(portsOf($).state)
  return runtime
}

/**
 * /clear, /resume and /branch give a new id and reset $.state, and `session.start` does not fire again. `session.end`
 * runs first and sees the leaving session: the manager stores it and keeps a snapshot. The first hook, tick or flush
 * that finds the new id runs the switch: /clear carries the snapshot into the new state, /resume loads the stored copy
 * of the new id (with the transcript), and an id with no stored copy starts empty.
 */
function managerOf($: EngineInterface): LifecycleManager {
  const items = runtimeOf($)
  manager ??= new LifecycleManager(
    {
      trackers: buildTrackers({ autoGithub: items.autoGithub }),
      items,
      dismiss: p => autoDismiss(p.state.slot),
      global: GLOBAL_DEFAULTS,
      paneId: PANE,
    },
    portsOf($),
  )
  return manager
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

/** The x button: the manager adds the id to the dismiss list first, drops the item key second, then the trackers hear of it. */
async function dismissOne($: EngineInterface, id: string): Promise<void> {
  try {
    await enter($)
    await managerOf($).dismiss(portsOf($), [id])
  } catch {
    // The row stays. The person can press again.
  }
}

/**
 * The first step of every event hook, command and button press: the start (once per load), the session check, then the
 * watchdog of the 30 s tick (A1). One refused period ends a `clock.every` for good, so all of them come through here.
 * Render hooks do not: a render must not start timers.
 */
function enter($: EngineInterface): Promise<void> {
  return managerOf($).entry(portsOf($))
}

// ------------------------------------------------------------------ tool calls the item trackers will own

/** The two statuses the sections read. A tool the record does not list yet reads as not probed. */
const viewTools = (x: Record<string, ToolStatus>): { gh: ToolStatus; acli: ToolStatus } => ({
  gh: x.gh ?? IDLE_GH,
  acli: x.acli ?? IDLE_ACLI,
})

/**
 * An Artifact tool call (issue #29). A publish tracks the page with source `publish`. A delete marks its row;
 * a dismissed or unknown artifact gets no row. Errors, refusals and other actions change nothing.
 * Transitional: the artifact tracker takes this over in plan Task 12.
 */
async function applyArtifactCall(items: ItemStorePort, input: unknown, ran: unknown): Promise<void> {
  const ev = artifactEvent(input, ran)
  if (!ev) return
  if (ev.kind === 'published') return items.track([ev.ref] as unknown as Claim[], 'publish')
  // No such row: a write would change nothing (A22), and `update` skips it.
  await items.update(list => markArtifactDeleted(list as unknown as ItemRecord[], ev.key) as unknown as StoredItem[])
}

/** The Write, Edit and Read hooks: track the Markdown file. The auto tracker counts the call as a sign of life (A7). */
async function onFileTool($: EngineInterface, tool: string, ran: unknown, agentId: string | undefined): Promise<void> {
  try {
    await enter($)
    await runtimeOf($).touchFile(tool, ran, agentId)
  } catch {
    // Tracking a file must not change the tool result.
  }
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
    sessionRepo: runtimeOf($).sessionRepo,
    auto: await readAuto($),
    ...(autoCheckedAt !== undefined ? { autoCheckedAt } : {}),
    ...(bodyColumns !== undefined ? { bodyColumns } : {}),
  }
}

/** The context of the `/track` text: waits for the repo first, so `#N` keys are right. */
async function viewContext($: EngineInterface): Promise<ViewContext> {
  await runtimeOf($).ensureRepo()
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
    await runtimeOf($).setPriority(id, level)
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
  // list is a literal, so a new door edits this line (E17).
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

  // The Artifact tool: a publish tracks the page, a delete marks its row. The result goes back unchanged.
  on('tool.call', { tool: 'Artifact' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await enter($)
      await applyArtifactCall(runtimeOf($), e, ran)
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
    const items = runtimeOf($)
    if (!items.ready) return { text: 'artifact-tracking: not ready.' }
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      // In `claude -p` the command may run before acli answers `--version`. The probes are cached.
      // Wait for them and for the repo first, so the pane's first drawing is already right (also after /clear).
      await items.settleProbes()
      await items.ensureRepo()
      await managerOf($).command(portsOf($), { sub: '', args: '', wait: true })
      await openPane($)
      items.kick('open')
      return { text: await listText($) }
    }
    if (arg === 'refresh') {
      await items.refreshAll()
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
      if ((await items.prio(ref, word)) === 'not-tracked') return { text: `Not tracked: ${ref}` }
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
        runtimeOf($).kick('manual')
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

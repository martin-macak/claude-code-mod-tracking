// Wiring for the artifact-tracking mod. The only file that touches `$` or calls `on`: the atoms, `portsOf`, one
// LifecycleManager per load and one hook per engine event. The manager, the trackers and the item host do the work.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.3 (the hook table).

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { ConfigManager } from '../core/infra/config-manager'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { Json, StoredItem } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import { DISMISS, TRACKERS } from '../trackers'
import { renderBand } from '../ux/band'
import { renderSections } from '../ux/pane'
import type { ToolStatus, UiState } from './contracts'
import { rowEvent, spawnEvent, toolCallEvent, turnEvent } from './events'
import { listText } from './list-text'
import { type PaneFocus, paneActions, pickRow } from './pane-actions'
import { parseRemote } from './scan/refs'
import { composeBand, composePane } from './ui/auto-view'
import { focusTargets } from './ui/view'
import { IDLE_ACLI, IDLE_GH, viewInputs } from './view-inputs'

// Working set in $.state (survives hot reload, reset by /clear). Persistence copies it to $.store, one key per session.
// The contract (types/index.d.ts) has four keys: `items`, `tools` and `ui` are atoms; each tracker's data is one member
// of the `trackers` family (spec 5.13, decision D14).
const items = atom({ plugin: 'artifact-tracking', key: 'items' } as const, [] as StoredItem[])
const tools = atom(
  { plugin: 'artifact-tracking', key: 'tools' } as const,
  { gh: IDLE_GH, acli: IDLE_ACLI } as Record<string, ToolStatus>,
)
const ui = atom({ plugin: 'artifact-tracking', key: 'ui' } as const, { folded: [] } as UiState)

/** A tracker fault or a refused write must not change what the engine returns: run the step, ignore a failure. */
async function soft(step: () => unknown): Promise<void> {
  try {
    await step()
  } catch {
    // The manager and the trackers log their own faults.
  }
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
        get: () => read($, items),
        update: fn => update($, items, fn),
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
      invalidate: () => void soft(() => $.ui.invalidate('ui.render')), // a refused redraw: the next one fixes it
      toast: text => $.ui.toast(text),
    },
    log: line => void soft(() => $.ui.log(line, { to: 'debug' })), // a log line must never fail a hook
  }
}

const PANE = 'track'

// Module state. A hot reload loses it. Each part is rebuilt on the next use.
let manager: LifecycleManager | undefined
/** The row the priority keys act on, and the element map of the last drawing. Never stored. */
const focus: PaneFocus = { row: undefined, rows: new Map() }

/**
 * The lifecycle of this load: the start sequence, the session switch (/clear, /resume, /branch), `session.end`, the
 * store, the bus and the item host. Built on the first hook; the ports of that hook serve its collaborators.
 */
function managerOf($: EngineInterface): LifecycleManager {
  if (manager) return manager
  manager = new LifecycleManager(
    {
      trackers: TRACKERS,
      dismiss: (p, c) => DISMISS(p.state.slot, () => c.global().store.maxDismissed),
      // The config file: read at the start and on the tick, written once per load (L4). The manager knows the trackers
      // only as `{ id, config }`.
      config: p => new ConfigManager({ fs: p.fs, env: p.env, specs: TRACKERS, log: p.log }),
      paneId: PANE,
      // The text of the list for /track: the legacy composers until L6 (K19). Read at call time, the manager is set by then.
      listText: p => listText(p, managerOf($)),
    },
    portsOf($),
  )
  return manager
}

export const register: Register = on => {
  // Once per process: register the command, then the start sequence (the run record, the trackers, the stored session
  // and the transcript of a resume, the tick and the pane).
  on('session.start', async ($, e, next) => {
    await soft(() =>
      $.command.register({
        name: 'track',
        description: 'Show tracked GitHub, Jira, artifacts, web links and Markdown files',
        argumentHint: managerOf($).commands.hint(),
      }),
    ) // a refused command: capture and restore still work
    await soft(() => managerOf($).start(portsOf($), { cwd: e.cwd, fromSessionStart: true }))
    return next(e)
  }).catch((_$, e, next) => next(e))

  // The leaving session is stored here, while $.state and the id are still its own (E6). Before `next`, within the budget.
  on('session.end', async ($, e, next) => {
    await soft(() => managerOf($).end(portsOf($), e.reason, next.budget.remainingMs)) // best effort: the session must end
    return next(e)
  }).catch((_$, e, next) => next(e))

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
      await soft(() => managerOf($).row(portsOf($), rowEvent(e, stored)))
      return stored
    },
  ).catch((_$, e, next) => next(e))

  // Every tool call: the trackers pick the tools they declared. A tool no tracker declared goes straight through, with
  // no entry and no cwd read. A persisted `cd` moves the session cwd during the run, so it is read before the call.
  on('tool.call', async ($, e, next) => {
    const m = managerOf($)
    if (!m.wants(e.tool)) return next(e)
    const cwdBefore = (await $.session.cwd().catch(() => undefined)) ?? undefined
    const ran = await next(e)
    await soft(() => m.toolCall(portsOf($), toolCallEvent(e, ran, cwdBefore)))
    return ran
  }).catch((_$, e, next) => next(e))

  // A subagent or a workflow agent starts. `next` gives its id. The master cwd is read before `next`: it is the
  // spawn-time location of a child of the main loop (A6).
  on('agent.spawn', async ($, e, next) => {
    let sessionCwd: string | undefined
    if (e.cwd === undefined && e.parentAgentId === undefined) sessionCwd = await $.session.cwd().catch(() => undefined)
    const out = await next(e)
    await soft(() => managerOf($).agentSpawn(portsOf($), spawnEvent(e, out, sessionCwd)))
    return out
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    await soft(() => managerOf($).turnComplete(portsOf($), turnEvent(e)))
    return out
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'track' }, ($, e) => managerOf($).track(portsOf($), e.args)).catch(() => ({
    text: 'artifact-tracking: could not run the command.',
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const p = portsOf($)
    const m = managerOf($)
    const v = await viewInputs(p, m.facts, { bodyColumns: e.props.bodyColumns, live: id => m.live(id) })
    const sections = composePane(v.items, v.processes, v.processUi, v.ctx, v.repos)
    focus.rows = focusTargets(sections)
    return renderSections(el, sections, e.props.bodyColumns, paneActions(p, m, focus))
  }).catch(($, e) => {
    // A failed read must not close the pane. Draw one line instead.
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Tracking is unavailable. Run /track to try again.</Text>
  })

  // One line above the prompt. The engine's own band stays inside our Box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = managerOf($)
    const v = await viewInputs(portsOf($), m.facts, { live: id => m.live(id) })
    const text = composeBand(v.items, v.processes, v.ctx.auto ?? null, v.repos)
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

  // These two hooks only observe. The entry (the lazy start, the session check) runs beside the key: after a /resume
  // it can load the stored copy and read the transcript, which may call `gh`, and the key must not wait for that.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    pickRow(focus, e)
    void soft(() => managerOf($).entry(portsOf($)))
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    focus.row = undefined
    void soft(() => managerOf($).entry(portsOf($)))
    return next(e)
  }).catch((_$, e, next) => next(e))

  // PromptComposer comes in layer L7. Until then the hook passes the prompt on (decision D19).
  on('prompt.compose', (_$, e, next) => next(e)).catch((_$, e, next) => next(e))
}

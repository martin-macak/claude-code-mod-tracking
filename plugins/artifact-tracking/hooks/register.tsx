// Wiring for the artifact-tracking mod. The only file that touches `$` or calls `on`: the atoms, `portsOf`, one
// LifecycleManager per load and one hook per engine event. The manager, the trackers and the item host do the work.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.3 (the hook table).

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { ConfigManager } from '../core/infra/config-manager'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { Json, StoredItem } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import { DISMISS, parseRemote, TRACKERS } from '../trackers'
import type { ToolStatus } from '../types'
import { bandText, renderBand } from '../ux/band'
import { TreeDataTable } from '../ux/tree-data-table/table'
import { rowEvent, spawnEvent, toolCallEvent, turnEvent } from './events'
import { helpTextOf, listText, PaneSession } from './pane-session'

// Working set in $.state (survives hot reload, reset by /clear). Persistence copies it to $.store, one key per session.
// The contract (types/index.d.ts): `items` and `tools` are atoms; each tracker's data is one member of the `trackers`
// family (spec 5.13, decision D14).
const items = atom({ plugin: 'artifact-tracking', key: 'items' } as const, [] as StoredItem[])
/** A tool nobody asked yet: not probed, nothing broken. */
const idle = (name: string): ToolStatus => ({ name, available: null, loggedIn: null, breaker: 'closed' })
// One entry per tool the trackers declare, so a new tool is declared by its tracker alone.
const tools = atom(
  { plugin: 'artifact-tracking', key: 'tools' } as const,
  Object.fromEntries(TRACKERS.flatMap(t => t.tools ?? []).map(spec => [spec.id, idle(spec.id)])) as Record<
    string,
    ToolStatus
  >,
)
// The pane state (spec 5.13): the row ids the person opened, the selected row, the help view. `shown` is a family and
// has no atom: its ref is a literal inside each closure of `portsOf`.
const expanded = atom({ plugin: 'artifact-tracking', key: 'expanded' } as const, [] as string[])
const selected = atom({ plugin: 'artifact-tracking', key: 'selected' } as const, null as string | null)
const help = atom({ plugin: 'artifact-tracking', key: 'help' } as const, false)
const hidden = atom({ plugin: 'artifact-tracking', key: 'hidden' } as const, { showAll: false })

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
    // The folder of plugin.json, for the version (issue #65). A getter: read only when asked, so a refusal stays inside
    // that one read and cannot break the ports of every other hook.
    plugin: {
      get root() {
        return $.plugin.root
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
    // A submit never waits: a press that awaits its own prompt hangs when it runs inside a turn. The answer comes in a
    // detached step: `{ drop }` is a hook that refused the prompt, a throw is a call the engine refused. Neither is an error.
    prompt: {
      submit: (text, onRefused) =>
        void soft(async () => {
          try {
            const out = await $.prompt.submit({ text })
            if (out?.drop !== undefined) onRefused?.(out.drop)
          } catch (e) {
            onRefused?.(e instanceof Error ? e.message : String(e))
          }
        }),
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
      expanded: { get: () => read($, expanded), update: fn => update($, expanded, fn) },
      selected: { get: () => read($, selected), update: fn => update($, selected, fn) },
      help: { get: () => read($, help), update: fn => update($, help, fn) },
      hidden: { get: () => read($, hidden), update: fn => update($, hidden, fn) },
      shown: {
        get: async id => (await read($, { plugin: 'artifact-tracking', key: 'shown', id } as const)) ?? 0,
        update: (id, fn) => update($, { plugin: 'artifact-tracking', key: 'shown', id } as const, cur => fn(cur ?? 0)),
      },
      slot: {
        get: id => read($, { plugin: 'artifact-tracking', key: 'trackers', id } as const),
        update: (id, fn) => update($, { plugin: 'artifact-tracking', key: 'trackers', id } as const, cur => fn(cur)),
      },
    },
    ui: {
      open: async () =>
        (await $.ui.open({ id: 'track', title: 'Tracking', focus: true, closeOnEscape: true })).isPlaced,
      focus: async key => (await $.ui.focus({ requestId: 'track', key })).deny === undefined,
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
/** What the pane keeps outside the engine state: the last drawing and the work behind its Buttons. One per load (E7). */
const pane = new PaneSession()

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
      // The text of the list and of the help view for /track: the text of the sections the pane draws (K19). Read at call
      // time, the manager is set by then.
      listText: p => listText(p, managerOf($)),
      helpText: p => helpTextOf(p, managerOf($)),
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

  // The sections of every tracker, drawn by one TreeDataTable. A render only reads (E9). A failed read must not close
  // the pane: it draws one line instead.
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) =>
    pane.draw(portsOf($), managerOf($), $.ui.resolve(e), {
      bodyColumns: e.props.bodyColumns,
      bodyRows: e.props.scroll?.bodyRows,
      focused: e.props.isFocused,
    }),
  ).catch(($, e) => TreeDataTable.unavailable($.ui.resolve(e)))

  // One line above the prompt, made from the sections that carry a band part. The engine's own band stays inside our Box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const line = bandText(await managerOf($).bandData(portsOf($)))
    if (line === null) return next(e)
    return renderBand($.ui.resolve(e), line, await next(e))
  }).catch((_$, e, next) => next(e)) // a failed read leaves the band to the engine

  // The ring moved. `next` runs first: a write before a deny would stick (tree-table 3.3). A row handle selects its row.
  // The entry (the lazy start, the session check) runs beside the key: after a /resume it can load the stored copy and
  // read the transcript, which may call a tracker's tool, and the key must not wait for that.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const p = portsOf($)
    void soft(() => managerOf($).entry(p))
    const r = await next(e)
    if (r.deny === undefined) await pane.focused(p, e.element)
    return r
  }).catch((_$, e, next) => next(e))

  // The pane closed: no selection, no help view.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const p = portsOf($)
    void soft(() => managerOf($).entry(p))
    await pane.closed(p)
    return next(e)
  }).catch((_$, e, next) => next(e))

  // The tracked items as one session section, added after the engine's own (spec 5.11). The manager builds its text at
  // the boundaries of the lifecycle, so this reads module memory only: no engine call, no start, no state write, and no
  // session check. A load that has no manager yet returns the engine's list.
  on('prompt.compose', async (_$, e, next) => {
    const answer = await next(e)
    return { sections: manager?.compose(e, answer.sections) ?? answer.sections }
  }).catch((_$, e, next) => next(e))
}

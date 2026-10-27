// `/track` through the Commands router. The moved L3 cases run on a real LifecycleManager over fakePorts (the empty
// command, refresh, clear, prio and the usage line, each mirroring the kit test of the same subject in
// register.test.tsx). The cases of the router alone run on a fake CommandHost, so they see the order of the calls.
// Plan: L3 Task 12 (the moved cases), L5 Task 9 (the router, K15, K19).
import { expect, test } from 'claude-code/testing'
import type { CleanRun } from '../core/infra/clean'
import { CORE_HINT, type CommandHost, Commands, PRIO_WORDS, USAGE } from '../core/infra/commands'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { MoreProblems } from '../core/interfaces/config'
import type { CommandEvent } from '../core/interfaces/events'
import type { CommandSpec, Tracker } from '../core/interfaces/tracker'
import { planLines, planText } from '../core/lib/clean-text'
import { helpOf } from '../hooks/pane-text'
import { autoDismiss } from '../trackers/auto/dismiss-store'
import { helpText } from '../ux/tree-data-table/help'
import { fakeConfig } from './fixtures/config-fs'
import { promptRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { fakePorts, MANIFEST_FILE } from './fixtures/ports'

const USAGE_LITERAL =
  'Usage: /track [refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <high|normal|low|auto>]'

/** A tracker that writes the commands it hears to `log`, with the number of items at that moment. */
function recorder(log: string[], count: () => number): Tracker {
  return {
    id: 'recorder',
    order: 5,
    config: { defaults: { enabled: true }, normalise: (_raw, defaults) => defaults },
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { command: (_ctx, ev) => void log.push(`command:${ev.sub || '-'}:${ev.wait}:${count()}`) },
  }
}

function world() {
  const log: string[] = []
  const w = managerWorld({ extra: [recorder(log, () => w.keys().length)] })
  const run = (args: string) => w.m.track(w.w.ports, args)
  const see = (text: string) => w.m.row(w.w.ports, promptRow(text))
  return { ...w, log, run, see }
}

test('the empty command opens the pane, runs the tracker commands and prints the text', async () => {
  const t = world()
  expect((await t.run('')).text).toBe('No tracked items yet.')
  expect(t.w.ui.opened).toBe(1)
  expect(t.w.ui.toasts).toEqual([])
  expect(t.log).toEqual(['command:-:true:0'])
  await t.see('look at https://docs.example/a')
  expect((await t.run('')).text).toContain('docs.example/a')
  expect(t.w.calls.filter(c => c[0] === 'gh' && c[1] === '--version').length).toBe(1) // the probes are cached
})

test('the empty command toasts when the pane has no room, and still prints the text', async () => {
  const t = world()
  t.w.ui.placed = false
  expect((await t.run('')).text).toBe('No tracked items yet.')
  expect(t.w.ui.toasts).toEqual(['Widen the terminal to see the tracking pane'])
})

test('refresh refreshes the items, then runs the tracker commands', async () => {
  const t = world()
  const order: string[] = []
  const refreshAll = t.rt.refreshAll.bind(t.rt)
  t.rt.refreshAll = async () => {
    order.push('items')
    await refreshAll()
    order.push('items done')
  }
  await t.see('https://github.com/acme/web/issues/9')
  t.log.length = 0
  const out = await t.run('refresh')
  expect(order).toEqual(['items', 'items done'])
  expect(t.log).toEqual(['command:refresh:true:1']) // after the items were refreshed, with the item still listed
  expect(out.text).toContain('#9')
})

test('clear runs the tracker commands, then clears the list and the stored copy', async () => {
  const t = world()
  await t.see('look at https://docs.example/a')
  await t.w.clock.advance(1600) // the flush writes the stored copy
  expect(t.w.store.has('v2:s:sess-1')).toBe(true)
  const out = await t.run('clear')
  expect(out.text).toBe('Tracking list cleared.')
  expect(t.log).toEqual(['command:clear:true:1']) // the trackers hear it while the list is still there
  expect(t.keys()).toEqual([])
  expect(t.w.store.has('v2:s:sess-1')).toBe(false)
})

test('prio sets a level by ref and saves it before the reply', async () => {
  const t = world()
  await t.see('see https://github.com/acme/web/issues/9')
  expect(t.w.store.has('v2:s:sess-1')).toBe(false) // the flush is 1.5 s away
  const out = await t.run('prio #9 high')
  expect(out.text).toContain('#9')
  const copy = t.w.store.get('v2:s:sess-1') as unknown as { items: { priority?: string }[] }
  expect(copy.items[0]?.priority).toBe('high') // flushed now, no clock advance
  await t.run('PRIO #9 auto')
  expect((t.items()[0] as { priority?: string }).priority).toBeUndefined()
})

test('prio of an untracked ref says Not tracked', async () => {
  const t = world()
  expect((await t.run('prio #99 high')).text).toBe('Not tracked: #99')
})

test('a bad level or a bogus argument prints the usage', async () => {
  const t = world()
  await t.see('see https://github.com/acme/web/issues/9')
  for (const args of ['prio #9 urgent', 'prio #9', 'bogus', 'refresh now']) expect((await t.run(args)).text).toBe(USAGE)
  expect((t.items()[0] as { priority?: string }).priority).toBeUndefined()
})

// ---------------------------------------------------------------- the router alone, on a fake host

type Declared = { owner: string; spec: CommandSpec }

/** A CommandHost that writes each call to `calls`, in order. `LIST` stands for the text of the list. */
function fakeHost(
  o: {
    ready?: boolean
    declared?: readonly Declared[]
    rowId?: (ref: string) => string | undefined
    problems?: readonly string[]
    /** The problems the config left out of `problems` (issue #144). */
    more?: MoreProblems
    flush?: () => Promise<void>
    version?: string
    /** The start has not read a manifest (it failed before): the host has no version. */
    noVersion?: boolean
    /** What the list text says. Default `LIST`. */
    listText?: string
    /** What `cleanup.plan` gives. Default: no step, no failure. */
    plan?: CleanRun
  } = {},
) {
  const calls: string[] = []
  const note = (line: string) => void calls.push(line)
  const host: CommandHost = {
    entry: async () => note('entry'),
    items: {
      ready: o.ready ?? true,
      prepare: async () => note('prepare'),
      settle: async () => note('settle'),
      kick: reason => note(`kick:${reason}`),
      refreshAll: async () => note('refreshAll'),
      rowIdOf: async ref => {
        note(`rowIdOf:${ref}`)
        return o.rowId?.(ref)
      },
    },
    setPriority: async (_p, id, level) => note(`setPriority:${id}:${level}`),
    broadcast: async (_p, ev: CommandEvent) => note(`broadcast:${ev.sub || '-'}:${ev.args}:${ev.wait}`),
    declared: () => o.declared ?? [],
    runDeclared: async (_p, owner, ev) => note(`run:${owner}:${ev.sub}:${ev.args}:${ev.wait}`),
    textOf: async (_p, owner, spec, args) => {
      note(`textOf:${owner}:${spec.sub}:${args}`)
      return `TEXT ${owner}:${spec.sub}:${args}`
    },
    openPane: async () => note('openPane'),
    clear: async () => note('clear'),
    flushNow: async () => {
      note('flushNow')
      await o.flush?.()
    },
    refreshConfig: async () => {
      note('refreshConfig')
      return false
    },
    config: { path: () => '/p/config.json', problems: () => o.problems ?? [], moreProblems: () => o.more },
    turnText: async (_p, n) => {
      note(`turnText:${n ?? '-'}`)
      return `TURN ${n ?? 'last'}`
    },
    version: () => (o.noVersion ? undefined : (o.version ?? '1.2.3')),
    cleanup: {
      plan: async () => {
        note('clean:plan')
        return o.plan ?? { lines: [], failed: [] }
      },
      apply: async (_p, kinds) => {
        note(`clean:apply:${kinds.join(',')}`)
        return { lines: [], failed: [] }
      },
      history: async () => {
        note('clean:history')
        return []
      },
    },
  }
  const commands = new Commands(
    host,
    async () => o.listText ?? 'LIST',
    async () => 'HELP',
  )
  return { commands, calls, ports: fakePorts().ports }
}

const notes = (owner: string, hint = '<id>'): Declared => ({ owner, spec: { sub: 'notes', hint } })

test('the empty command keeps the order: config, probes, repo, trackers, pane, kick, list', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, '')).text).toBe('LIST')
  expect(t.calls).toEqual([
    'entry',
    'refreshConfig',
    'settle',
    'prepare',
    'broadcast:-::true',
    'openPane',
    'kick:open',
    'prepare', // the list waits for the repo too
  ])
})

test('refresh and clear keep their order, and clear prints no list', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, ' REFRESH ')).text).toBe('LIST')
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'refreshAll', 'broadcast:refresh::true', 'prepare'])
  t.calls.length = 0
  expect((await t.commands.run(t.ports, 'clear')).text).toBe('Tracking list cleared.')
  expect(t.calls).toEqual(['entry', 'broadcast:clear::true', 'clear'])
})

test('show-all checks the config file first, so an edit of hideEnded or a TTL shows at once, then prints the list', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, 'show-all')).text).toBe('Showing all rows.\n\nLIST')
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'prepare'])
  t.calls.length = 0
  expect((await t.commands.run(t.ports, 'show-all')).text).toBe('Hiding ended rows again.\n\nLIST')
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'prepare'])
})

test('view sets the session view after the config check, and prints the list with the View line first (issue #63, L3)', async () => {
  const t = fakeHost()
  const out = await t.commands.run(t.ports, 'view status')
  expect(out.text).toBe('View: status\n\nLIST')
  expect(await t.ports.state.view.get()).toBe('status')
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'prepare'])
  // The list text of a view other than by list says the view itself: the reply keeps it once.
  const said = fakeHost({ listText: 'View: status\n\nLIST' })
  expect((await said.commands.run(said.ports, ' View  STATUS ')).text).toBe('View: status\n\nLIST')
})

test('view with an unknown name, with no name or with more words prints the usage and sets nothing', async () => {
  const t = fakeHost()
  for (const args of ['view', 'view type', 'view status flat', 'view constructor'])
    expect((await t.commands.run(t.ports, args)).text).toBe('Usage: /track view <list|tracker|status|reason|flat>')
  expect(await t.ports.state.view.get()).toBeNull()
  expect(t.calls).toEqual(['entry', 'entry', 'entry', 'entry']) // no config check, no list
})

test('view is a core sub-command: a tracker cannot take it', async () => {
  const t = fakeHost({ declared: [{ owner: 'a', spec: { sub: 'view', hint: '<x>' } }] })
  expect((await t.commands.run(t.ports, 'view flat')).text).toBe('View: flat\n\nLIST')
  expect(t.calls.some(c => c.startsWith('run:'))).toBe(false)
  expect(t.commands.hint()).toBe(CORE_HINT)
})

// Issue #123: the plan reads the switches `destroyWorktrees` (and later `destroyContainers`), so an edit of the file
// just before `--yes` must count. Every mode checks the file first, like `show-all`.
test('clean checks the config file, then prints the plan and nothing else: no list, no flush', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, 'clean')).text).toContain('Clean plan. Nothing changed.')
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'clean:plan'])
})

// Issue #199: the pane key reads the plan as typed lines. The reply of the command is the same lines, joined.
const STEPS: CleanRun = {
  lines: [
    { step: { kind: 'tasks', id: 'task:1', label: 'sleep 300', action: 'stop' } },
    { step: { kind: 'worktrees', id: 'wt:/a', label: '/a', action: 'remove-record', skip: 'not merged' } },
  ],
  failed: ['auto: plan failed: boom'],
}

test('cleanPlan checks the config file, then plans, and gives the typed lines: no entry, no list, no apply', async () => {
  const t = fakeHost({ plan: STEPS })
  const plan = await t.commands.cleanPlan(t.ports)
  expect(plan).toEqual(planLines(STEPS.lines, STEPS.failed))
  expect(plan.map(l => l.role)).toContain('step')
  expect(t.calls).toEqual(['refreshConfig', 'clean:plan']) // the caller made the entry; the plan mode of the command does
})

test('clean prints the lines of cleanPlan joined, and checks the config file once', async () => {
  const t = fakeHost({ plan: STEPS })
  const text = (await t.commands.run(t.ports, 'clean')).text
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'clean:plan']) // the plan mode reads through cleanPlan: no second check
  expect(text).toBe(planText(STEPS.lines, STEPS.failed))
  expect(text).toBe((await t.commands.cleanPlan(t.ports)).map(l => l.text).join('\n'))
})

test('clean --log checks the config file, then prints the log and nothing else', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, ' CLEAN  --log ')).text).toBe('The clean log is empty.')
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'clean:history'])
})

test('clean --yes <kind> applies, saves before it replies, and prints the result and then the list', async () => {
  const t = fakeHost()
  const text = (await t.commands.run(t.ports, 'clean --yes tasks worktrees')).text
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'clean:apply:tasks,worktrees', 'flushNow', 'prepare'])
  expect(text).toMatch(/^Cleaned: tasks, worktrees\.\n[\s\S]*\n\nLIST$/)
})

test('a failed flush does not fail the reply of clean --yes', async () => {
  const t = fakeHost({
    flush: async () => {
      throw new Error('disk full')
    },
  })
  expect((await t.commands.run(t.ports, 'clean --yes tasks')).text).toContain('Cleaned: tasks.')
})

test('clean --hide sets hidden.before, redraws, and prints the list; the plan and the log are not asked', async () => {
  const t = fakeHost()
  t.ports.clock.after(0, () => {}) // the fake clock is at 0: the hide time is its wall time
  const text = (await t.commands.run(t.ports, 'clean --hide')).text
  expect(text).toBe('Ended rows hidden. /track show-all shows them again.\n\nLIST')
  expect(await t.ports.state.hidden.get()).toEqual({ showAll: false, before: 0 })
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'prepare'])
})

test('a clean call with an argument that is no mode prints the usage and does not read the config file', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, 'clean --yes')).text).toContain('Usage: /track clean')
  expect(t.calls).toEqual(['entry'])
})

test('a word that only starts with clean is not clean', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, 'cleanup')).text).toBe(USAGE)
  expect((await t.commands.run(t.ports, 'clean --now')).text).toContain('Usage: /track clean')
  expect(t.calls).toEqual(['entry', 'entry'])
})

test('an item host that never started says it is not ready', async () => {
  const t = fakeHost({ ready: false })
  expect((await t.commands.run(t.ports, '')).text).toBe('artifact-tracking: not ready.')
  expect(t.calls).toEqual(['entry']) // no pane, no refresh, no broadcast
})

test('prio #5 with no session repo finds the unresolved gh:?#5', async () => {
  const t = fakeHost({ rowId: ref => (ref === '#5' ? 'gh:?#5' : undefined) })
  expect((await t.commands.run(t.ports, 'prio #5 high')).text).toBe('LIST')
  expect(t.calls).toEqual(['entry', 'rowIdOf:#5', 'setPriority:gh:?#5:high', 'flushNow', 'prepare'])
})

test('prio auto removes the mark, a word keeps the case of the ref, and a failed flush does not fail the reply', async () => {
  const t = fakeHost({
    rowId: ref => ref,
    flush: async () => {
      throw new Error('disk full')
    },
  })
  expect((await t.commands.run(t.ports, 'Prio  ISS-9   AUTO')).text).toBe('LIST')
  expect(t.calls).toContain('rowIdOf:ISS-9')
  expect(t.calls).toContain('setPriority:ISS-9:undefined')
  expect([...PRIO_WORDS].sort()).toEqual(['auto', 'high', 'low', 'normal'])
})

test('a ref that names no row says Not tracked and sets nothing', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, 'prio nope low')).text).toBe('Not tracked: nope')
  expect(t.calls).toEqual(['entry', 'rowIdOf:nope'])
})

test('a declared command runs only its first owner and prints the list', async () => {
  const t = fakeHost({ declared: [notes('a'), notes('b')] })
  expect((await t.commands.run(t.ports, 'notes 7')).text).toBe('LIST')
  expect(t.calls).toEqual(['entry', 'run:a:notes:7:true', 'prepare'])
})

test('a declared command takes its sub in any case, with no argument, and keeps the rest as typed', async () => {
  const t = fakeHost({ declared: [{ owner: 'a', spec: { sub: 'Notes', hint: '' } }] })
  await t.commands.run(t.ports, 'NOTES')
  await t.commands.run(t.ports, '  notes   Keep  The CASE  ')
  expect(t.calls.filter(c => c.startsWith('run:'))).toEqual(['run:a:Notes::true', 'run:a:Notes:Keep  The CASE:true'])
})

test('a sub that no tracker declared, or that core claims, prints the usage', async () => {
  const claimed: Declared[] = ['refresh', 'clear', 'prio', 'version'].map(sub => ({
    owner: 'a',
    spec: { sub, hint: '' },
  }))
  const t = fakeHost({ declared: [...claimed, notes('a')] })
  for (const args of ['nope', 'refresh now', 'clear all', 'prio #1 urgent', 'notesx'])
    expect((await t.commands.run(t.ports, args)).text).toBe(USAGE)
  expect(t.calls.some(c => c.startsWith('run:'))).toBe(false)
})

test('the hint is the core literal with no declared command and grows with one', () => {
  expect(fakeHost().commands.hint()).toBe(
    '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>]',
  )
  expect(CORE_HINT).toBe(
    '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>]',
  )
  const one = fakeHost({ declared: [notes('a')] }).commands.hint()
  expect(one).toBe(
    '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>|notes <id>]',
  )
  const more = fakeHost({
    declared: [
      notes('a'),
      notes('b', '<other>'), // the same sub again: the first owner runs it, so the hint lists it once
      { owner: 'b', spec: { sub: 'refresh', hint: '' } }, // core claims it first
      { owner: 'b', spec: { sub: 'sweep', hint: '' } }, // no hint text: no trailing space
    ],
  }).commands.hint()
  expect(more).toBe(
    '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>|notes <id>|sweep]',
  )
})

test('the usage line is the core literal and names help', () => {
  expect(USAGE).toBe(USAGE_LITERAL)
})

test('the replies that print the list end with the config problems after one blank line; clear and the usage do not', async () => {
  const t = fakeHost({ problems: ['X.'], rowId: ref => ref })
  const block = '\n\nConfig problems in /p/config.json:\n  X.'
  for (const args of ['', 'refresh', 'prio a high'])
    expect((await t.commands.run(t.ports, args)).text).toBe(`LIST${block}`)
  expect((await t.commands.run(t.ports, 'clear')).text).toBe('Tracking list cleared.')
  expect((await t.commands.run(t.ports, 'bogus')).text).toBe(USAGE)
})

test('help prints the help text after the config check: no pane, no kick, no list, no problems block', async () => {
  const t = fakeHost({ problems: ['X.'] })
  expect((await t.commands.run(t.ports, ' Help ')).text).toBe('HELP') // the help view lists the problems itself
  expect(t.calls).toEqual(['entry', 'refreshConfig'])
})

test('a tracker cannot take help: core answers it first and the hint lists it once', async () => {
  const t = fakeHost({ declared: [{ owner: 'a', spec: { sub: 'help', hint: '' } }] })
  expect((await t.commands.run(t.ports, 'help')).text).toBe('HELP')
  expect(t.calls.some(c => c.startsWith('run:'))).toBe(false)
  expect(t.commands.hint()).toBe(CORE_HINT)
})

test('an item host that never started says it is not ready, also for help', async () => {
  const t = fakeHost({ ready: false })
  expect((await t.commands.run(t.ports, 'help')).text).toBe('artifact-tracking: not ready.')
})

// ---------------------------------------------------------------- version (issue #65)

test('version prints the name and the version after the entry, with no config check, pane, kick or list', async () => {
  const t = fakeHost({ version: '0.2.0' })
  expect((await t.commands.run(t.ports, ' Version ')).text).toBe('artifact-tracking 0.2.0')
  expect(t.calls).toEqual(['entry']) // the entry has read the manifest by now
})

test('version prints unknown as any other version, and does not wait for a ready item host', async () => {
  const t = fakeHost({ ready: false, version: 'unknown' })
  expect((await t.commands.run(t.ports, 'version')).text).toBe('artifact-tracking unknown')
})

test('version prints unknown when the host has no version, because the start failed before it read the manifest', async () => {
  const t = fakeHost({ noVersion: true })
  expect((await t.commands.run(t.ports, 'version')).text).toBe('artifact-tracking unknown')
})

test('version takes no argument: a word after it prints the usage', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, 'version now')).text).toBe(USAGE)
})

test('a tracker cannot take version: core answers it first and the hint lists it once', async () => {
  const t = fakeHost({ declared: [{ owner: 'a', spec: { sub: 'version', hint: '' } }] })
  expect((await t.commands.run(t.ports, 'version')).text).toBe('artifact-tracking 1.2.3')
  expect(t.calls.some(c => c.startsWith('run:'))).toBe(false)
  expect(t.commands.hint()).toBe(CORE_HINT)
})

// ---------------------------------------------------------------- the router on the real manager

/** A tracker that declares `/track notes` and writes each command it hears to `log`. */
function noter(id: string, order: number, log: string[]): Tracker {
  return {
    id,
    order,
    config: {
      defaults: { enabled: true },
      normalise: (raw, defaults) => ({ ...defaults, enabled: raw.enabled !== false }),
    },
    init: () => {},
    store: ctx => ctx.config.slice(),
    commands: [{ sub: 'notes', hint: '<id>' }],
    events: { command: (_ctx, ev) => void log.push(`${id}:${ev.sub || '-'}:${ev.args}:${ev.wait}`) },
  }
}

test('a declared command of a live tracker runs through the manager: its first owner only, no broadcast', async () => {
  const log: string[] = []
  const t = managerWorld({ extra: [noter('second', 7, log), noter('first', 6, log)] })
  // The questions tracker declares `qa [n]` (issue #71); it sits last, at order 90.
  expect(t.m.commands.hint()).toBe(
    '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>|notes <id>|qa [n]]',
  )
  expect((await t.m.track(t.w.ports, 'notes 7')).text).toBe('No tracked items yet.')
  expect(log).toEqual(['first:notes:7:true'])
})

test('a tracker the config turned off declares no command', async () => {
  const log: string[] = []
  const t = managerWorld({
    extra: [noter('first', 6, log)],
    config: specs => fakeConfig({ specs, file: { trackers: { first: { enabled: false } } } }),
  })
  await t.m.entry(t.w.ports) // the start reads the toggles
  expect(t.m.commands.hint()).toBe(`${CORE_HINT.slice(0, -1)}|qa [n]]`) // the questions tracker is on
  expect((await t.m.track(t.w.ports, 'notes 7')).text).toBe(USAGE)
  expect(log).toEqual([])
})

test('a declared command that throws is logged and the list still prints', async () => {
  const t = managerWorld({
    extra: [{ ...noter('first', 6, []), events: { command: () => Promise.reject(new Error('boom')) } }],
  })
  expect((await t.m.track(t.w.ports, 'notes 7')).text).toBe('No tracked items yet.')
  expect(t.w.logs.some(l => l.includes('bus: command failed in first: boom'))).toBe(true)
})

test('help prints the help view as text and does not open the pane', async () => {
  const t = managerWorld()
  const out = await t.m.track(t.w.ports, 'help')
  expect(out.text.startsWith('Pane keys (Tab, Shift+Tab, Up, Down move between rows)\n  r  refresh')).toBe(true)
  expect(out.text).toContain('Config file:')
  expect(t.w.ui.opened).toBe(0)
})

test('version prints the version the manifest names, read once by the start', async () => {
  const t = managerWorld({ fake: { files: { [MANIFEST_FILE]: '{"name":"artifact-tracking","version":"3.4.5"}' } } })
  expect((await t.m.track(t.w.ports, 'version')).text).toBe('artifact-tracking 3.4.5')
  expect((await t.m.track(t.w.ports, 'version')).text).toBe('artifact-tracking 3.4.5')
  expect(t.w.reads.filter(path => path === MANIFEST_FILE)).toEqual([MANIFEST_FILE]) // one read per load
  expect(t.w.ui.opened).toBe(0)
})

test('a manager has no version before its first start, so a help view drawn before it has no Version line', async () => {
  const t = managerWorld({ fake: { files: { [MANIFEST_FILE]: '{"name":"artifact-tracking","version":"3.4.5"}' } } })
  expect(t.m.version).toBeUndefined() // not `unknown`: that word means the manifest was read and gave nothing
  expect(helpOf(t.m, []).version).toBeUndefined()
  expect(helpText(helpOf(t.m, []))).not.toContain('Version:')
  await t.m.track(t.w.ports, 'version')
  expect(t.m.version).toBe('3.4.5')
  expect(helpOf(t.m, []).version).toBe('3.4.5')
})

test('version prints unknown when the manifest cannot be read, and the rest of /track works as before', async () => {
  const t = managerWorld() // no manifest on the fake disk
  expect((await t.m.track(t.w.ports, 'version')).text).toBe('artifact-tracking unknown')
  expect((await t.m.track(t.w.ports, '')).text).toBe('No tracked items yet.')
  expect(t.w.ui.opened).toBe(1)
  expect(t.m.items.ready).toBe(true)
})

test('a bad argument prints the usage line with help', async () => {
  const t = managerWorld()
  expect((await t.m.track(t.w.ports, 'bogus')).text).toBe(
    'Usage: /track [refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <high|normal|low|auto>]',
  )
})

test('a manager with no listText or helpText in its deps prints no text', async () => {
  const w = fakePorts()
  const m = new LifecycleManager(
    { trackers: [], dismiss: p => autoDismiss(p.state.slot), config: () => fakeConfig({ specs: [] }), paneId: 'track' },
    w.ports,
  )
  await m.start(w.ports, { fromSessionStart: true, cwd: '/work' })
  expect(m.items.ready).toBe(true)
  expect((await m.track(w.ports, 'refresh')).text).toBe('')
  expect((await m.track(w.ports, 'help')).text).toBe('')
})

// ---------------------------------------------------------------- /track turn [n] (issue #69)

test('turn asks the host for the newest turn, or turn n, and prints no list and opens no pane', async () => {
  const t = fakeHost()
  expect((await t.commands.run(t.ports, 'turn')).text).toBe('TURN last')
  expect((await t.commands.run(t.ports, ' TURN  7 ')).text).toBe('TURN 7')
  expect(t.calls).toEqual(['entry', 'turnText:-', 'entry', 'turnText:7'])
})

test('turn takes a whole number from 1 and prints its own usage for any other word, after the ready check', async () => {
  const t = fakeHost()
  for (const word of ['0', '-1', 'x', '1.5', '1 2', '1234567890', '07x'])
    expect((await t.commands.run(t.ports, `turn ${word}`)).text).toBe('Usage: /track turn [n]')
  expect(t.calls.filter(c => c.startsWith('turnText'))).toEqual([])
  const idle = fakeHost({ ready: false })
  expect((await idle.commands.run(idle.ports, 'turn')).text).toBe('artifact-tracking: not ready.')
})

test('a tracker cannot declare the sub turn: core owns it', async () => {
  const mine: Declared = { owner: 'mine', spec: { sub: 'turn', hint: '<x>' } }
  const t = fakeHost({ declared: [mine] })
  expect((await t.commands.run(t.ports, 'turn')).text).toBe('TURN last')
  expect(t.calls.some(c => c.startsWith('run:'))).toBe(false)
})

// ---------------------------------------------------------------- a declared command with a text of its own (issue #71)

test('a declared command that has a text answers with it: the router runs no command event and prints no list', async () => {
  const say: Declared = { owner: 'a', spec: { sub: 'qa', hint: '[n]', text: () => 'not called by the fake host' } }
  const t = fakeHost({ declared: [say] })
  expect((await t.commands.run(t.ports, 'QA 3')).text).toBe('TEXT a:qa:3')
  expect((await t.commands.run(t.ports, 'qa')).text).toBe('TEXT a:qa:')
  // The config file first, as `/track`, `refresh`, `help` and `show-all` do: a text may depend on a toggle that was just edited.
  expect(t.calls).toEqual(['entry', 'refreshConfig', 'textOf:a:qa:3', 'entry', 'refreshConfig', 'textOf:a:qa:'])
})

test('a declared command with no text checks no config of its own: the tracker handles the command', async () => {
  const t = fakeHost({ declared: [notes('a')] })
  await t.commands.run(t.ports, 'notes 3')
  expect(t.calls).not.toContain('refreshConfig')
})

test('a declared command with a text prints that text through the manager, built from the context of its tracker', async () => {
  const sayer: Tracker = {
    ...noter('first', 6, []),
    commands: [{ sub: 'say', hint: '[word]', text: async (ctx, args) => `${ctx.id} says ${args || 'nothing'}` }],
  }
  const t = managerWorld({ extra: [sayer] })
  expect(t.m.commands.hint()).toContain('say [word]')
  expect((await t.m.track(t.w.ports, 'say hello there')).text).toBe('first says hello there')
  expect((await t.m.track(t.w.ports, 'SAY')).text).toBe('first says nothing')
  expect(t.w.ui.opened).toBe(0)
})

test('a text that throws rejects, as any failure of a command does, and prints no list', async () => {
  const sayer: Tracker = {
    ...noter('first', 6, []),
    commands: [{ sub: 'say', hint: '', text: () => Promise.reject(new Error('no words')) }],
  }
  const t = managerWorld({ extra: [sayer] })
  await expect(t.m.track(t.w.ports, 'say')).rejects.toThrow('no words')
})

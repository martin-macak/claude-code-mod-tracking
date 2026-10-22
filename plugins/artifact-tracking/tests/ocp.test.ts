// The open-closed proof (spec 7 and 9: "a new tracker is its folder plus one line"). A test-local tracker `notes` joins
// the shipped list through the list alone: no line of core, ux or the shipped trackers changes. It brings a kind (its
// URLs, its record, its refresh and its row), a tool, a `/track` sub-command, a command handler and a pane section. The
// manager captures its URLs, probes and runs its tool, draws its section and routes its command. The tracker imports
// only what spec 5.1 lets a tracker import: core/interfaces and core/lib.
// Plan: L5 Task 16.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import { NO_VIEW } from '../core/infra/views'
import type { Claim, ItemKind, Refreshable, RefreshContext, StoredItem } from '../core/interfaces/items'
import type { KindReason } from '../core/interfaces/reasons'
import type { Tracker } from '../core/interfaces/tracker'
import type { SectionSpec, ViewContext } from '../core/interfaces/view'
import { bool, specOf } from '../core/lib/normalise'
import { kindReason, reasonOfSource, reasonSet } from '../core/lib/reasons'
import { type BaseRecord, sighted } from '../core/lib/records'
import { itemRow, sortedByLevel } from '../core/lib/rows'
import { DISMISS, TRACKERS } from '../trackers'
import { fakeConfig } from './fixtures/config-fs'
import { promptRow, res, toolResultRow } from './fixtures/items'
import { fakePorts } from './fixtures/ports'

// ---------------------------------------------------------------- the test-local tracker

type NoteRecord = BaseRecord & { category: 'note'; title?: string }

const NOTE_URL = /^https:\/\/notes\.example\/n\/(\d+)$/

/** A note that `notes-cli show <id>` fills in. It is due until it has a title. */
class Note implements Refreshable {
  readonly category = 'note'
  constructor(
    readonly rec: NoteRecord,
    private readonly ctx: RefreshContext,
  ) {}
  get key(): string {
    return this.rec.key
  }
  canRefresh(now: number): boolean {
    return this.ctx.tools.handle('notes-cli')?.canCall(now) ?? false
  }
  isDue(): boolean {
    return this.rec.title === undefined
  }
  toRecord(): StoredItem {
    return this.rec
  }
}

/** The reasons of the notes: a note that a tool result showed was `reviewed`, which a filter reads as `read` (issue #62). */
const NOTE_REASONS: readonly KindReason[] = [{ id: 'reviewed', core: 'read' }]

const noteKind: ItemKind<NoteRecord> = {
  category: 'note',
  rank: 50,
  reasons: NOTE_REASONS,
  claimUrl(url, _label, ctx): Claim | null {
    const id = NOTE_URL.exec(url)?.[1]
    if (id === undefined) return null
    return {
      category: 'note',
      key: `note:${id}`,
      source: ctx.source,
      reason: ctx.source === 'tool' ? kindReason(ctx.kindReasons, 'reviewed') : reasonOfSource(ctx.source),
      at: ctx.now,
      fields: { url, label: `note ${id}` },
    }
  },
  decode: item => (item.category === 'note' ? (item as NoteRecord) : null),
  merge: (cur, seen) =>
    cur !== null
      ? sighted(cur, seen)
      : {
          key: seen.key,
          category: 'note',
          url: String(seen.fields.url),
          label: String(seen.fields.label),
          sources: [seen.source],
          reasons: reasonSet(seen.reason),
          firstSeen: seen.at,
          lastSeen: seen.at,
          seenCount: 1,
        },
  refresh: {
    tool: 'notes-cli',
    fields: ['title'],
    hydrate: (item, ctx) => new Note(item, ctx),
    async refreshItems(items, ctx) {
      const handle = ctx.tools.handle('notes-cli')
      for (const item of items as Note[]) {
        const out = await handle?.exec(['notes-cli', 'show', item.key.slice('note:'.length)])
        if (out?.exitCode === 0) {
          item.rec.title = (JSON.parse(out.stdout) as { title: string }).title
          item.rec.refreshedAt = ctx.now()
          handle?.record('ok')
        } else handle?.record('tool-failure', out?.stderr)
      }
    },
  },
  row: (item, ctx: Pick<ViewContext, 'levelOf'>) =>
    itemRow({
      id: item.key,
      owner: 'notes',
      level: ctx.levelOf(item.key),
      dismiss: true,
      reasons: item.reasons,
      text: { key: item.label, href: item.url, title: item.title ?? '' },
    }),
}

/** What the `notes` command handler heard: the arguments of each `/track notes …`. */
function notesTracker(heard: string[]): Tracker {
  return {
    id: 'notes',
    order: 65,
    config: specOf({ enabled: bool(true) }),
    kinds: [noteKind],
    tools: [{ id: 'notes-cli', probe: ['notes-cli', '--version'] }],
    commands: [{ sub: 'notes', hint: '<id>' }],
    events: {
      // The pane opens with an empty command, which every tracker hears. Only this sub-command is the tracker's.
      command: (_ctx, ev) => void (ev.sub === 'notes' && heard.push(ev.args)),
    },
    init: () => {},
    store: ctx => ctx.config.slice(),
    sections: (ctx): readonly SectionSpec[] => {
      const own = sortedByLevel(
        ctx.items.flatMap(item => noteKind.decode(item) ?? []),
        ctx.levelOf,
      )
      if (own.length === 0) return []
      return [
        {
          id: 'notes',
          title: 'Notes',
          rank: 65,
          rows: own.map(rec => noteKind.row(rec, ctx)),
        },
      ]
    },
  }
}

// ---------------------------------------------------------------- the world

/**
 * A manager over fake ports with the shipped trackers and, when `withNotes` is set, `notes` after them. `notes-cli`
 * answers its probe and `show 7`; every other argv, `gh` and `acli` included, exits 127.
 */
function world(o: { withNotes?: boolean; off?: readonly string[] } = {}) {
  const heard: string[] = []
  const trackers = o.withNotes === false ? [...TRACKERS] : [...TRACKERS, notesTracker(heard)]
  const w = fakePorts({ session: { cwd: '/work', repo: { host: 'github.com', owner: 'acme', repo: 'web' } } })
  w.run = argv => {
    const [tool, ...rest] = argv
    if (tool === 'notes-cli' && rest[0] === '--version') return res('notes-cli 1.0.0')
    if (tool === 'notes-cli' && rest.join(' ') === 'show 7') return res(JSON.stringify({ title: 'Seven' }))
    return res('', 127, `${tool}: command not found`)
  }
  const file = { trackers: Object.fromEntries((o.off ?? []).map(id => [id, { enabled: false }])) }
  const m = new LifecycleManager(
    {
      trackers,
      dismiss: (p, c) => DISMISS(p.state.slot, () => c.global().store.maxDismissed),
      config: () => fakeConfig({ specs: trackers, file }),
      paneId: 'track',
    },
    w.ports,
  )
  const items = () => (w.state.get('items') ?? []) as unknown as StoredItem[]
  const see = (text: string) => m.row(w.ports, promptRow(text))
  return { w, m, heard, items, see, keys: () => items().map(i => i.key) }
}

const ran = (calls: string[][], ...argv: string[]) => calls.some(c => c.join(' ') === argv.join(' '))

// ---------------------------------------------------------------- the proof

test('ocp: a tracker added only through a test-local list is captured, refreshed, drawn and routed', async () => {
  const t = world()
  const p = t.w.ports
  await t.m.ensureStarted(p)

  // The tool: declared, probed once, and its status is in the plugin state.
  expect(ran(t.w.calls, 'notes-cli', '--version')).toBe(true)
  expect((await p.state.tools.get())['notes-cli']?.available).toBe(true)

  // Capture: the note URL goes to the kind of the lower rank, never also to web. Position order within the prompt.
  await t.see('Read https://notes.example/n/7 and https://example.com/a')
  expect(t.keys()).toEqual(['note:7', 'web:https://example.com/a'])

  // Priority: the generic resolver finds the row by the kind's claim and writes the person's mark.
  await t.m.track(p, 'prio https://notes.example/n/7 high')
  expect(t.items().find(i => i.key === 'note:7')?.priority).toBe('high')

  // Refresh: the kind's lane runs the tool through the handle the tracker declared and writes the status field.
  await t.m.track(p, 'refresh')
  expect(ran(t.w.calls, 'notes-cli', 'show', '7')).toBe(true)
  const note = t.items().find(i => i.key === 'note:7')
  expect(note?.title).toBe('Seven')
  expect(typeof note?.refreshedAt).toBe('number')

  // The pane: the section sits by its rank right after Web links, and its row is the one the kind draws.
  const sections = await t.m.paneData(p, NO_VIEW)
  const ids = sections.map(s => s.id)
  expect(ids[ids.indexOf('web') + 1]).toBe('notes')
  const notes = sections.find(s => s.id === 'notes')
  expect(notes?.title).toBe('Notes')
  expect(notes?.rows.map(r => [r.id, r.owner, r.cells.description?.text])).toEqual([['note:7', 'notes', 'Seven']])

  // The router: the sub-command reaches the tracker's handler with its arguments, and the hint names it.
  await t.m.track(p, 'notes 7')
  expect(t.heard).toEqual(['7'])
  // The hint lists the declared subs in tracker order: the test tracker (order 65) comes just before `qa [n]` of the questions
  // tracker (order 90), the last of the shipped list. The tail pins both places, as `endsWith('|notes <id>]')` did.
  expect(t.m.commands.hint().endsWith('|notes <id>|qa [n]]')).toBe(true)

  expect(TRACKERS.length).toBe(9) // the shipped list did not change
  expect(TRACKERS.some(x => x.id === 'notes')).toBe(false)
})

test('ocp: the new tracker gets reasons through the base contract, with no edit of a shared type (#62)', async () => {
  const t = world()
  const p = t.w.ports
  await t.m.ensureStarted(p)

  // A prompt names the note: a mention. A tool result shows it: the kind's `reviewed`, which the core reads as `read`.
  await t.see('Look at https://notes.example/n/7')
  expect(t.items().find(i => i.key === 'note:7')).toMatchObject({
    sources: ['prompt'],
    reasons: { first: 'mentioned', all: ['mentioned'], strongest: 'mentioned' },
  })
  await t.m.row(p, toolResultRow('opened https://notes.example/n/7'))
  const note = t.items().find(i => i.key === 'note:7')
  expect(note?.sources).toEqual(['prompt', 'tool'])
  expect(note?.reasons).toEqual({ first: 'mentioned', all: ['read', 'mentioned'], strongest: 'read' })

  // The row of the kind carries them to the pane, where the detail lists them all.
  const row = (await t.m.paneData(p, NO_VIEW)).find(s => s.id === 'notes')?.rows[0]
  expect(row?.reasons).toEqual(note?.reasons)

  // The kind's own word fails when it is not declared, and a kind that declares none has none to use.
  expect(() => kindReason(noteKind.reasons, 'liked')).toThrow(/liked/)
  expect(noteKind.reasons?.map(r => [r.id, r.core])).toEqual([['reviewed', 'read']])
})

test('ocp: without the tracker the same URL is a plain web link and the section is gone', async () => {
  const t = world({ withNotes: false })
  const p = t.w.ports
  await t.m.ensureStarted(p)
  await t.see('Read https://notes.example/n/7 and https://example.com/a')
  expect(t.keys()).toEqual(['web:https://notes.example/n/7', 'web:https://example.com/a'])
  expect(ran(t.w.calls, 'notes-cli', '--version')).toBe(false)
  expect((await t.m.paneData(p, NO_VIEW)).some(s => s.id === 'notes')).toBe(false)
  expect(t.m.commands.hint()).not.toContain('notes')
})

test('ocp: the config turns the new tracker off like any other: no probe, no claim, no section, no command', async () => {
  const t = world({ off: ['notes'] })
  const p = t.w.ports
  await t.m.ensureStarted(p)
  await t.see('Read https://notes.example/n/7')
  expect(t.keys()).toEqual([]) // a kind that is off still owns its span, so no web link either (spec 10, call 10)
  expect(ran(t.w.calls, 'notes-cli', '--version')).toBe(false)
  expect((await t.m.paneData(p, NO_VIEW)).some(s => s.id === 'notes')).toBe(false)
  await t.m.track(p, 'notes 7')
  expect(t.heard).toEqual([])
})

// The turn ledger algebra (issue #69), over the orders a live run showed: the person's prompt row before its
// `turn.start`, a subagent that works on after its turn ended, a task notice that wakes the main loop, an aborted end.
// The ids and texts below are the ones of the probe log of the design study (comment 2, L3 to L49 and L132).
import { expect, test } from 'claude-code/testing'
import type { CoreReason } from '../core/interfaces/items'
import type { Sightings, TurnEntry, TurnLedger } from '../core/interfaces/turns'
import {
  countOf,
  joinSightings,
  keysOf,
  latestWithEntries,
  MAX_ENTRIES,
  NO_SIGHTINGS,
  sightingsOf,
  withSightings,
} from '../core/lib/turn-entries'
import { joinLedgers, ledgerFrom, persisted, persistedChanged } from '../core/lib/turn-store'
import {
  called,
  commitTurn,
  emptyLedger,
  excerpt,
  isTaskNotice,
  MAX_MAPPED,
  MAX_TURNS,
  noteSightings,
  noticeOf,
  openTurn,
  PROMPT_CHARS,
  personPrompt,
  recordOf,
  spawned,
  startsTask,
  targetOf,
  taskNotice,
} from '../core/lib/turns'

const entry = (k: string, r: CoreReason = 'mentioned', c = 'github'): TurnEntry => ({ k, c, r })
const found = (...added: TurnEntry[]): Sightings => ({ added, seen: [] })
const again = (...seen: TurnEntry[]): Sightings => ({ added: [], seen })

const PROMPT = 'probe turn one: track https://github.com/o/r/pull/5'
const NOTICE = `<task-notification>\n<task-id>afe3f3796716e44ee</task-id>\n<tool-use-id>tu_agent1_main2</tool-use-id>\nthe agent is done`
const AGENT = 'afe3f3796716e44ee'

const open = (l: TurnLedger, turnId: string, text = PROMPT, at = 100): TurnLedger =>
  openTurn(l, { turnId, text, session: 's1', at })

/** The observed order of run A: prompt row, turn.start, spawn of a background agent, turn.complete. */
function runA(): TurnLedger {
  let l = personPrompt(emptyLedger(), PROMPT)
  l = noteSightings(l, targetOf(l, { person: true }), found(entry('gh:o/r#5')))
  l = open(l, '1cbb654c')
  l = spawned(l, { agentId: AGENT, toolUseId: 'tu_agent1_main2' })
  return commitTurn(l, { turnId: '1cbb654c', reason: 'answer', at: 200 })
}

test('R1: turn.start opens a record with the next ordinal and the engine turnId; turn.complete commits it with the engine word', () => {
  const l = open(emptyLedger(), '1cbb654c')
  expect(l.next).toBe(2)
  expect(l.open).toEqual({ ord: 1, turnId: '1cbb654c' })
  expect(l.turns[0]).toMatchObject({ ord: 1, turnId: '1cbb654c', session: 's1', startedAt: 100, new: [], seen: [] })
  expect(l.turns[0]!.end).toBeUndefined() // absent while it runs
  const done = commitTurn(l, { turnId: '1cbb654c', reason: 'answer', at: 250 })
  expect(done.open).toBeUndefined()
  expect(done.turns[0]).toMatchObject({ end: 'answer', endedAt: 250 })
  const second = open(done, 'b2e06d64', 'turn two')
  expect(second.turns.map(r => r.ord)).toEqual([1, 2])
})

test('R1: the end words are the engine words; aborted is stored as aborted, and a word that is not one is not stored', () => {
  for (const reason of ['answer', 'aborted', 'refusal', 'error'] as const) {
    const l = commitTurn(open(emptyLedger(), 't'), { turnId: 't', reason, at: 1 })
    expect(l.turns[0]!.end).toBe(reason)
  }
  const odd = commitTurn(open(emptyLedger(), 't'), { turnId: 't', reason: 'completed', at: 1 })
  expect(odd.turns[0]!.end).toBeUndefined()
  expect(odd.turns[0]!.endedAt).toBe(1)
  expect(odd.open).toBeUndefined()
})

test('R1: the end of a turn that is not the running one changes nothing', () => {
  const l = open(emptyLedger(), 't1')
  expect(commitTurn(l, { turnId: 'other', reason: 'answer', at: 5 })).toBe(l)
  expect(commitTurn(emptyLedger(), { turnId: 't1', reason: 'answer', at: 5 })).toEqual(emptyLedger())
})

test('R2: the prompt row comes first; its items wait in pending with the ordinal the next turn gets, and turn.start adopts them', () => {
  let l = personPrompt(emptyLedger(), PROMPT)
  expect(l.pending).toMatchObject({ ord: 1, prompt: PROMPT, new: [], seen: [] })
  const target = targetOf(l, { person: true })
  expect(target).toEqual({ ord: 1, pending: true })
  l = noteSightings(l, target, found(entry('gh:o/r#5', 'mentioned')))
  expect(l.pending!.new).toEqual([entry('gh:o/r#5', 'mentioned')])
  l = open(l, '1cbb654c')
  expect(l.pending).toBeUndefined()
  expect(l.turns[0]).toMatchObject({ ord: 1, prompt: PROMPT, new: [entry('gh:o/r#5')] })
  expect(l.open!.ord).toBe(1) // the ordinal the items were stamped with
})

test('R2: a turn.start text that differs from the prompt row is adopted by order, and the row keeps its prompt', () => {
  let l = personPrompt(emptyLedger(), 'what the person typed')
  l = noteSightings(l, targetOf(l, { person: true }), found(entry('k1')))
  l = open(l, 't1', 'text after a hook rewrote it')
  expect(l.turns[0]).toMatchObject({ prompt: 'what the person typed', new: [entry('k1')] })
})

test('R2: main-loop work with no running turn and no prompt row is not stamped', () => {
  expect(targetOf(emptyLedger(), {})).toBeUndefined()
  expect(targetOf(runA(), {})).toBeUndefined()
  // A response row after the commit has no turn: it is not the person's, and nothing runs.
  expect(noteSightings(runA(), undefined, found(entry('x')))).toEqual(runA())
})

test('R2: work of the main loop goes to the running turn, also from a person prompt row typed during it', () => {
  const l = open(emptyLedger(), 't1')
  expect(targetOf(l, {})).toEqual({ ord: 1 })
  expect(targetOf(l, { person: true })).toEqual({ ord: 1 })
  expect(personPrompt(l, 'typed during the turn')).toBe(l)
})

test('R2: a prompt that no turn followed leaves its entries for the next turn, which keeps the newest prompt', () => {
  let l = personPrompt(emptyLedger(), 'dropped prompt')
  l = noteSightings(l, targetOf(l, { person: true }), found(entry('k1')))
  l = personPrompt(l, 'the next prompt')
  l = noteSightings(l, targetOf(l, { person: true }), found(entry('k2')))
  expect(l.pending).toMatchObject({ ord: 1, prompt: 'the next prompt', new: [entry('k1'), entry('k2')] })
  expect(open(l, 't1').turns[0]).toMatchObject({ prompt: 'the next prompt', new: [entry('k1'), entry('k2')] })
})

test('R3: a subagent spawned in a turn maps to it; its work goes there while the turn runs, and after it ended as late', () => {
  let l = open(emptyLedger(), '1cbb654c')
  l = spawned(l, { agentId: AGENT, toolUseId: 'tu_agent1_main2' })
  expect(l.agents).toEqual([[AGENT, 1]])
  expect(l.calls).toEqual([['tu_agent1_main2', 1]])
  expect(targetOf(l, { agentId: AGENT })).toEqual({ ord: 1 })
  l = commitTurn(l, { turnId: '1cbb654c', reason: 'answer', at: 200 })
  // The sub's tool result and end came after the main end (L29, L30, L35).
  const late = targetOf(l, { agentId: AGENT })
  expect(late).toEqual({ ord: 1, late: true })
  l = noteSightings(l, late, found(entry('web:example.com/a', 'read', 'web')))
  expect(l.turns[0]!.new).toEqual([{ k: 'web:example.com/a', c: 'web', r: 'read', late: true }])
})

test('R3: a later turn does not take the work of an agent that an earlier turn spawned', () => {
  let l = spawned(open(emptyLedger(), 't1'), { agentId: AGENT })
  l = open(commitTurn(l, { turnId: 't1', reason: 'answer', at: 5 }), 't2', 'next')
  expect(targetOf(l, { agentId: AGENT })).toEqual({ ord: 1, late: true })
  expect(targetOf(l, {})).toEqual({ ord: 2 })
})

test('R3: an agent id the ledger does not know falls back to the running turn, then to the newest, then to nothing', () => {
  const running = open(emptyLedger(), 't1')
  // The sub heard its own turn.start before the spawn answer (L16, L17): the id is not mapped yet.
  expect(targetOf(running, { agentId: 'unknown' })).toEqual({ ord: 1 })
  const ended = commitTurn(running, { turnId: 't1', reason: 'answer', at: 5 })
  expect(targetOf(ended, { agentId: 'unknown' })).toEqual({ ord: 1, late: true })
  expect(targetOf(emptyLedger(), { agentId: 'unknown' })).toBeUndefined()
})

test('R3: an agent whose turn the cap dropped falls back like an unknown one', () => {
  let l = spawned(open(emptyLedger(), 't0'), { agentId: AGENT })
  for (let i = 1; i <= MAX_TURNS; i++)
    l = open(commitTurn(l, { turnId: `t${i - 1}`, reason: 'answer', at: i }), `t${i}`, `p${i}`)
  expect(recordOf(l, 1)).toBeUndefined()
  expect(targetOf(l, { agentId: AGENT })).toEqual({ ord: MAX_TURNS + 1 })
})

test('R3: a nested spawn maps to the turn of its parent agent; with no parent it maps to the running turn, else the newest', () => {
  let l = open(emptyLedger(), 't1')
  l = spawned(l, { agentId: 'a1' })
  l = open(commitTurn(l, { turnId: 't1', reason: 'answer', at: 5 }), 't2', 'second')
  l = spawned(l, { agentId: 'child', parentAgentId: 'a1' }) // a1 belongs to turn 1
  expect(l.agents).toContainEqual(['child', 1])
  l = spawned(l, { agentId: 'a2' })
  expect(l.agents).toContainEqual(['a2', 2])
  const idle = commitTurn(l, { turnId: 't2', reason: 'answer', at: 6 })
  expect(spawned(idle, { agentId: 'a3' }).agents).toContainEqual(['a3', 2]) // the newest turn
  expect(spawned(emptyLedger(), { agentId: 'a3' })).toEqual(emptyLedger()) // no turn at all
  expect(spawned(l, {})).toBe(l)
})

test('R3: the maps of agents and calls keep the newest 200 pairs and one pair per id', () => {
  let l = open(emptyLedger(), 't1')
  for (let i = 0; i < MAX_MAPPED + 5; i++) l = spawned(l, { agentId: `a${i}`, toolUseId: `c${i}` })
  expect(l.agents).toHaveLength(MAX_MAPPED)
  expect(l.agents[0]![0]).toBe('a5')
  expect(l.calls).toHaveLength(MAX_MAPPED)
  const again = spawned(l, { agentId: 'a204', toolUseId: 'c204' })
  expect(again.agents).toHaveLength(MAX_MAPPED)
})

test('R4: a tool call of the main loop maps its id to the running turn; one with no id, or already mapped, changes nothing', () => {
  const l = open(emptyLedger(), 't1')
  const one = called(l, { toolUseId: 'tu_bg1_main3' })
  expect(one.calls).toEqual([['tu_bg1_main3', 1]])
  expect(called(one, { toolUseId: 'tu_bg1_main3' })).toBe(one)
  expect(called(l, {})).toBe(l)
  expect(called(emptyLedger(), { toolUseId: 'x' })).toEqual(emptyLedger()) // no turn runs
  // A call of a subagent maps to the turn of the subagent.
  const sub = called(spawned(l, { agentId: 'a1' }), { toolUseId: 'tu_sub1', agentId: 'a1' })
  expect(sub.calls).toContainEqual(['tu_sub1', 1])
})

test('R4: startsTask reads the result the engine gives: a Bash call names its background task, a Monitor its task', () => {
  // The answer of a tool call is { ref, result, text }; the task id is a member of `result` (tests/fixtures/notices.ts).
  expect(startsTask({ ref: 1, result: { stdout: '', backgroundTaskId: 'butoa45ib' }, text: 'running' })).toBe(true)
  expect(startsTask({ ref: 2, result: { taskId: 'mon1', timeoutMs: 1000 }, text: 'started' })).toBe(true)
  expect(startsTask({ result: { stdout: 'a', backgroundTaskId: '' } })).toBe(false)
  expect(startsTask({ result: { backgroundTaskId: 7 } })).toBe(false)
  // A flat object is not the shape of the engine's answer.
  expect(startsTask({ stdout: '', backgroundTaskId: 'butoa45ib' })).toBe(false)
  expect(startsTask({ taskId: 'mon1' })).toBe(false)
  expect([{}, null, undefined, 'text', 4, [], { result: null }, { result: 'x' }].map(startsTask)).toEqual(
    Array(8).fill(false),
  )
})

test('R7: persistedChanged is true for a change of a stored part and false for the run state alone', () => {
  const idle = emptyLedger()
  const prompted = personPrompt(idle, 'hello')
  expect(persistedChanged(idle, prompted)).toBe(false) // the pending bucket is not stored
  expect(persistedChanged(prompted, taskNotice(prompted, NOTICE))).toBe(false) // nor is a notice
  const opened = open(prompted, 't1')
  expect(persistedChanged(prompted, opened)).toBe(true) // a record and the counter
  expect(persistedChanged(opened, commitTurn(opened, { turnId: 't1', reason: 'answer', at: 5 }))).toBe(true)
  expect(persistedChanged(opened, spawned(opened, { agentId: 'a1' }))).toBe(true)
  expect(persistedChanged(opened, called(opened, { toolUseId: 'tu1' }))).toBe(true)
  expect(persistedChanged(opened, opened)).toBe(false)
})

test('R4: a task notice wakes the main loop: no new ordinal, the work goes to the turn that started the task (L39, L40)', () => {
  let l = runA()
  expect(l.next).toBe(2)
  l = taskNotice(l, NOTICE)
  expect(l.wake).toEqual({ taskId: AGENT, toolUseId: 'tu_agent1_main2' })
  l = open(l, 'ddb8e262', NOTICE, 300)
  expect(l.next).toBe(2) // no ordinal for the wake
  expect(l.turns).toHaveLength(1)
  expect(l.open).toEqual({ ord: 1, turnId: 'ddb8e262', wake: true })
  expect(l.wake).toBeUndefined()
  expect(l.turns[0]!.wakes).toBe(1)
  expect(targetOf(l, {})).toEqual({ ord: 1 })
  const woken = noteSightings(l, targetOf(l, {}), found(entry('web:example.com/spare1', 'mentioned', 'web')))
  expect(woken.turns[0]!.new.map(e => e.k)).toEqual(['gh:o/r#5', 'web:example.com/spare1'])
  // The end of the wake closes it and leaves the record: the first end word and time stay.
  const done = commitTurn(woken, { turnId: 'ddb8e262', reason: 'answer', at: 360 })
  expect(done.open).toBeUndefined()
  expect(done.turns[0]).toMatchObject({ end: 'answer', endedAt: 200, wakes: 1 })
})

test('R4: a wake is found by its text alone when the prompt row was bypassed', () => {
  const l = open(runA(), 'ddb8e262', NOTICE)
  expect(l.next).toBe(2)
  expect(l.open).toEqual({ ord: 1, turnId: 'ddb8e262', wake: true })
})

test('R4: a notice whose tool call and id are unknown wakes the newest turn; with no turn at all the work is not stamped', () => {
  let l = open(runA(), 't2', 'second prompt')
  l = commitTurn(l, { turnId: 't2', reason: 'answer', at: 400 })
  const stranger = '<task-notification>\n<task-id>zzz</task-id>\n<tool-use-id>tu_none</tool-use-id>'
  const woken = open(taskNotice(l, stranger), 'w', stranger)
  expect(woken.open).toEqual({ ord: 2, turnId: 'w', wake: true })
  const lonely = open(taskNotice(emptyLedger(), stranger), 'w', stranger)
  expect(lonely.open).toBeUndefined()
  expect(lonely.next).toBe(1)
  expect(lonely.wake).toBeUndefined()
})

test('R4: a background command wakes the turn that ran it, found by the tool call id', () => {
  let l = open(emptyLedger(), 't1')
  l = called(l, { toolUseId: 'tu_bg1_main3' })
  l = open(commitTurn(l, { turnId: 't1', reason: 'answer', at: 5 }), 't2', 'next prompt')
  l = commitTurn(l, { turnId: 't2', reason: 'answer', at: 6 })
  const note = '<task-notification>\n<task-id>b7g00b3v2</task-id>\n<tool-use-id>tu_bg1_main3</tool-use-id>'
  const woken = open(taskNotice(l, note), 'w', note)
  expect(woken.open).toEqual({ ord: 1, turnId: 'w', wake: true })
})

test('R4: a notice before the prompt of a person does not make that turn a wake, and a prompt row clears a stale notice', () => {
  let l = taskNotice(runA(), NOTICE) // queued, delivered inside a turn: no turn.start follows
  l = personPrompt(l, 'a new question')
  expect(l.wake).toBeUndefined()
  const opened = open(l, 't2', 'a new question')
  expect(opened.open).toEqual({ ord: 2, turnId: 't2' })
  expect(opened.next).toBe(3)
  // A notice seen while a turn runs is ignored: nothing follows it.
  const running = open(emptyLedger(), 't1')
  expect(taskNotice(running, NOTICE)).toBe(running)
})

test('R2: a prompt of the person that is itself notice-shaped text is a prompt, not a wake', () => {
  let l = runA()
  l = personPrompt(l, NOTICE) // the person pasted the text of a notice: its row is a person prompt row
  l = noteSightings(l, targetOf(l, { person: true }), found(entry('k1')))
  const opened = open(l, 't2', NOTICE)
  expect(opened.open).toEqual({ ord: 2, turnId: 't2' })
  expect(opened.next).toBe(3)
  expect(opened.turns.map(r => r.wakes)).toEqual([undefined, undefined])
  expect(opened.turns[1]!.new).toEqual([entry('k1')]) // the turn adopted the items of the prompt row
  expect(opened.pending).toBeUndefined()
})

test('R4: a wake keeps the prompt of a person that waits', () => {
  let l = personPrompt(runA(), 'waiting prompt')
  l = open(l, 'w', NOTICE)
  expect(l.pending?.prompt).toBe('waiting prompt')
  expect(l.open?.wake).toBe(true)
})

test('R4: isTaskNotice and noticeOf read the engine text; a text with neither tag gives no ids', () => {
  expect(isTaskNotice(NOTICE)).toBe(true)
  expect(isTaskNotice(`  \n${NOTICE}`)).toBe(true)
  expect(isTaskNotice('please look at <task-notification> later')).toBe(false)
  expect(noticeOf(NOTICE)).toEqual({ taskId: AGENT, toolUseId: 'tu_agent1_main2' })
  expect(noticeOf('<task-notification>\n<task-id> b7g </task-id>')).toEqual({ taskId: 'b7g' })
  expect(noticeOf('plain text')).toEqual({})
})

test('R5: a key that a turn added stays in new when a later claim of the turn names it, with the stronger reason', () => {
  let l = open(emptyLedger(), 't1')
  const at = targetOf(l, {})
  l = noteSightings(l, at, found(entry('k1', 'mentioned')))
  l = noteSightings(l, at, again(entry('k1', 'created')))
  expect(l.turns[0]!.new).toEqual([entry('k1', 'created')])
  expect(l.turns[0]!.seen).toEqual([])
  l = noteSightings(l, at, again(entry('k1', 'read'))) // weaker: the reason stays
  expect(l.turns[0]!.new).toEqual([entry('k1', 'created')])
})

test('R5: a known item that the turn saw again is listed once in seen, with the strongest reason of its claims', () => {
  let l = open(emptyLedger(), 't1')
  const at = targetOf(l, {})
  l = noteSightings(l, at, again(entry('k9', 'mentioned')))
  l = noteSightings(l, at, again(entry('k9', 'updated'), entry('k8', 'read')))
  expect(l.turns[0]!.seen).toEqual([entry('k9', 'updated'), entry('k8', 'read')])
  expect(l.turns[0]!.new).toEqual([])
})

test('R5: an item seen and then added in one turn moves to new, with the stronger of the two reasons', () => {
  let l = open(emptyLedger(), 't1')
  const at = targetOf(l, {})
  l = noteSightings(l, at, again(entry('k1', 'updated')))
  l = noteSightings(l, at, found(entry('k1', 'mentioned')))
  expect(l.turns[0]!.new).toEqual([entry('k1', 'updated')])
  expect(l.turns[0]!.seen).toEqual([])
})

test('R5: sightings that change nothing, or have no target or no entry, give the same ledger', () => {
  const l = noteSightings(open(emptyLedger(), 't1'), { ord: 1 }, found(entry('k1')))
  expect(noteSightings(l, { ord: 1 }, found(entry('k1')))).toBe(l)
  expect(noteSightings(l, { ord: 1 }, NO_SIGHTINGS)).toBe(l)
  expect(noteSightings(l, undefined, found(entry('k2')))).toBe(l)
  expect(noteSightings(l, { ord: 99 }, found(entry('k2')))).toBe(l) // a turn the cap dropped
  const p = noteSightings(emptyLedger(), { ord: 1, pending: true }, found(entry('k1')))
  expect(noteSightings(p, { ord: 1, pending: true }, found(entry('k1')))).toBe(p)
})

test('R5: a pending target with no prompt row yet makes the pending bucket', () => {
  const l = noteSightings(emptyLedger(), { ord: 1, pending: true }, found(entry('k1')))
  expect(l.pending).toMatchObject({ ord: 1, prompt: '', new: [entry('k1')] })
  expect(open(l, 't1', 'typed').turns[0]).toMatchObject({ prompt: 'typed', new: [entry('k1')] })
})

test('R7: a list keeps 50 entries and counts the rest; a counted key is not listed twice', () => {
  const many = Array.from({ length: MAX_ENTRIES + 7 }, (_, i) => entry(`k${i}`))
  let l = open(emptyLedger(), 't1')
  l = noteSightings(l, { ord: 1 }, found(...many))
  expect(l.turns[0]!.new).toHaveLength(MAX_ENTRIES)
  expect(l.turns[0]!.moreNew).toBe(7)
  const seen = Array.from({ length: MAX_ENTRIES + 2 }, (_, i) => entry(`s${i}`))
  l = noteSightings(l, { ord: 1 }, again(...seen))
  expect(l.turns[0]!.seen).toHaveLength(MAX_ENTRIES)
  expect(l.turns[0]!.moreSeen).toBe(2)
  expect(countOf(l.turns[0]!)).toEqual({ added: MAX_ENTRIES + 7, seen: MAX_ENTRIES + 2 })
  // The same key again strengthens a listed entry and counts nothing more.
  l = noteSightings(l, { ord: 1 }, found(entry('k0', 'created')))
  expect(l.turns[0]!.new[0]).toEqual(entry('k0', 'created'))
  expect(l.turns[0]!.moreNew).toBe(7)
  // Pending lists keep the same caps and carry the counts to the turn.
  let p = noteSightings(emptyLedger(), { ord: 1, pending: true }, found(...many))
  p = noteSightings(p, { ord: 1, pending: true }, again(...seen))
  const adopted = open(p, 't1', 'x').turns[0]!
  expect([adopted.new.length, adopted.moreNew, adopted.seen.length, adopted.moreSeen]).toEqual([
    MAX_ENTRIES,
    7,
    MAX_ENTRIES,
    2,
  ])
})

test('R7: a turn that adds 60 items and names them again lists no seen entry and counts moreNew 10', () => {
  const sixty = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => entry(`k${i}`))
  let l = noteSightings(open(emptyLedger(), 't1'), { ord: 1 }, found(...sixty))
  // The second capture names the same 60 items: the key is stamped by this turn already, so each is a repeat.
  l = noteSightings(l, { ord: 1 }, { added: [], seen: [], repeat: sixty.map(e => ({ ...e, r: 'created' as const })) })
  const rec = l.turns[0]!
  expect(rec.new).toHaveLength(MAX_ENTRIES)
  expect(rec.new[0]).toEqual(entry('k0', 'created')) // a listed entry takes the stronger reason
  expect(rec.moreNew).toBe(10)
  expect(rec.seen).toEqual([])
  expect(rec.moreSeen).toBeUndefined()
  expect(countOf(rec)).toEqual({ added: MAX_ENTRIES + 10, seen: 0 })
})

test('R7: one item that does not fit seen and is named three times counts once', () => {
  const fifty = Array.from({ length: MAX_ENTRIES }, (_, i) => entry(`s${i}`))
  let l = noteSightings(open(emptyLedger(), 't1'), { ord: 1 }, again(...fifty))
  l = noteSightings(l, { ord: 1 }, again(entry('extra'))) // the first sighting of the turn: it does not fit, so it counts
  l = noteSightings(l, { ord: 1 }, { added: [], seen: [], repeat: [entry('extra')] })
  l = noteSightings(l, { ord: 1 }, { added: [], seen: [], repeat: [entry('extra', 'updated')] })
  expect(l.turns[0]!.seen).toHaveLength(MAX_ENTRIES)
  expect(l.turns[0]!.moreSeen).toBe(1)
  expect(countOf(l.turns[0]!)).toEqual({ added: 0, seen: MAX_ENTRIES + 1 })
})

test('R5: a repeat strengthens the entry that is listed, in new or in seen, and makes no entry of its own', () => {
  let l = noteSightings(open(emptyLedger(), 't1'), { ord: 1 }, { added: [entry('n1')], seen: [entry('s1')] })
  const repeat = [entry('n1', 'created'), entry('s1', 'updated'), entry('ghost', 'created')]
  l = noteSightings(l, { ord: 1 }, { added: [], seen: [], repeat })
  expect(l.turns[0]!.new).toEqual([entry('n1', 'created')])
  expect(l.turns[0]!.seen).toEqual([entry('s1', 'updated')])
  expect(noteSightings(l, { ord: 1 }, { added: [], seen: [], repeat: [entry('ghost')] })).toBe(l) // not listed: no change
  expect(noteSightings(l, { ord: 1 }, { added: [], seen: [], repeat: [entry('n1', 'read')] })).toBe(l) // weaker: no change
  // A pending bucket takes repeats the same way.
  let p = noteSightings(emptyLedger(), { ord: 1, pending: true }, found(entry('p1')))
  p = noteSightings(p, { ord: 1, pending: true }, { added: [], seen: [], repeat: [entry('p1', 'created')] })
  expect(p.pending!.new).toEqual([entry('p1', 'created')])
  // A late repeat keeps the entry as it came.
  const late = withSightings(
    { new: [entry('n1')], seen: [] },
    { added: [], seen: [], repeat: [entry('n1', 'created')] },
    true,
  )
  expect(late.new).toEqual([entry('n1', 'created')])
})

test('R7: withSightings keeps the list objects when nothing changes, and marks late entries', () => {
  const lists = { new: [entry('k1')], seen: [] }
  expect(withSightings(lists, NO_SIGHTINGS, false)).toBe(lists)
  const late = withSightings(lists, again(entry('k2')), true)
  expect(late.seen).toEqual([{ ...entry('k2'), late: true }])
  // An entry that came in time keeps no late flag when a late claim names it again.
  expect(withSightings(lists, found(entry('k1', 'created')), true).new).toEqual([entry('k1', 'created')])
})

test('R7: the ledger keeps the newest 50 turns; the ordinal goes on', () => {
  let l = emptyLedger()
  for (let i = 1; i <= MAX_TURNS + 3; i++)
    l = open(commitTurn(l, { turnId: `t${i - 1}`, reason: 'answer', at: i }), `t${i}`, `p${i}`)
  expect(l.turns).toHaveLength(MAX_TURNS)
  expect(l.turns[0]!.ord).toBe(4)
  expect(l.turns.at(-1)!.ord).toBe(MAX_TURNS + 3)
  expect(l.next).toBe(MAX_TURNS + 4)
})

test('R7: excerpt keeps the first 60 characters, white space folded, whole characters only', () => {
  expect(PROMPT_CHARS).toBe(60)
  expect(excerpt('  fix   the\n\tflaky test ')).toBe('fix the flaky test')
  const long = 'abcdefghij'.repeat(10)
  expect(excerpt(long)).toBe(long.slice(0, 60))
  expect(excerpt('😀'.repeat(70))).toBe('😀'.repeat(60))
  expect(excerpt('')).toBe('')
  const l = personPrompt(emptyLedger(), `${long} and more`)
  expect(l.pending!.prompt).toHaveLength(60)
  expect(open(emptyLedger(), 't1', long).turns[0]!.prompt).toBe(long.slice(0, 60))
  expect(open(emptyLedger(), 't1', '   ').turns[0]!.prompt).toBeUndefined()
})

test('R5: sightingsOf makes one entry per key with the first category and the strongest reason of its claims', () => {
  const claims = [
    { key: 'a', category: 'github', reason: 'mentioned' as const },
    { key: 'b', category: 'web', reason: 'read' as const },
    { key: 'a', category: 'github', reason: 'created' as const },
    { key: 'a', category: 'github', reason: 'read' as const },
  ]
  expect(sightingsOf(claims, ['a'], ['b', 'gone'])).toEqual({
    added: [{ k: 'a', c: 'github', r: 'created' }],
    seen: [{ k: 'b', c: 'web', r: 'read' }],
  })
  expect(joinSightings(NO_SIGHTINGS, NO_SIGHTINGS)).toBe(NO_SIGHTINGS)
  const one = found(entry('a'))
  expect(joinSightings(one, NO_SIGHTINGS)).toBe(one)
  expect(joinSightings(one, again(entry('b')))).toEqual({ added: [entry('a')], seen: [entry('b')] })
  // Repeats are the third list: the same one entry per key, and no `repeat` member when there is none.
  expect(sightingsOf(claims, ['a'], [], ['b', 'gone'])).toEqual({
    added: [{ k: 'a', c: 'github', r: 'created' }],
    seen: [],
    repeat: [{ k: 'b', c: 'web', r: 'read' }],
  })
  const rep = { added: [], seen: [], repeat: [entry('r')] }
  expect(joinSightings(NO_SIGHTINGS, rep)).toEqual(rep)
  expect(joinSightings(rep, NO_SIGHTINGS)).toBe(rep)
  expect(joinSightings(one, rep)).toEqual({ added: [entry('a')], seen: [], repeat: [entry('r')] })
  expect(joinSightings(rep, one)).toEqual({ added: [entry('a')], seen: [], repeat: [entry('r')] })
  expect(joinSightings(rep, rep)).toEqual({ added: [], seen: [], repeat: [entry('r'), entry('r')] })
})

test('R10: the band reads the newest turn that tracked anything, the running one included; keysOf lists new first', () => {
  expect(latestWithEntries(emptyLedger())).toBeUndefined()
  let l = open(emptyLedger(), 't1')
  l = noteSightings(l, { ord: 1 }, { added: [entry('n1')], seen: [entry('s1')] })
  l = open(commitTurn(l, { turnId: 't1', reason: 'answer', at: 5 }), 't2', 'empty turn')
  expect(latestWithEntries(l)!.ord).toBe(1) // turn 2 has none
  l = noteSightings(l, { ord: 2 }, found(entry('n2')))
  expect(latestWithEntries(l)!.ord).toBe(2) // still running, and live
  expect(keysOf(l.turns[0]!)).toEqual(['n1', 's1'])
})

test('R7: a stored copy keeps the records and the counters, not the running turn, the pending prompt or a notice', () => {
  let l = personPrompt(runA(), 'next')
  l = taskNotice(l, NOTICE)
  l = open(l, 't2', 'next')
  const kept = persisted(l)
  expect(Object.keys(kept).sort()).toEqual(['agents', 'calls', 'next', 'turns'])
  expect(kept.turns).toBe(l.turns)
})

test('R7: ledgerFrom takes a stored value and drops what is not well formed', () => {
  const good = persisted(runA())
  expect(ledgerFrom(JSON.parse(JSON.stringify(good)))).toEqual(good)
  expect(ledgerFrom(undefined)).toBeUndefined()
  expect(ledgerFrom('x')).toBeUndefined()
  expect(ledgerFrom({ next: 3 })).toBeUndefined()
  const rough = {
    next: 'seven',
    turns: [
      {
        ord: 4,
        turnId: 'a',
        session: 's',
        startedAt: 1,
        end: 'completed',
        new: [{ k: 'k', c: 'c', r: 'created' }, { k: 1 }, null],
        seen: 'no',
        moreNew: 3.7,
        wakes: 0,
        prompt: `${'x'.repeat(100)}`,
        endedAt: 'late',
      },
      { ord: 'five', turnId: 'b', session: 's', startedAt: 1 },
      { ord: 6, turnId: 'c', session: 's' },
      null,
      {
        ord: 5,
        turnId: 'd',
        session: 's',
        startedAt: 2,
        end: 'refusal',
        endedAt: 9,
        seen: [{ k: 'z', c: 'c', r: 'read', late: true }],
        moreSeen: 2,
        wakes: 1,
      },
    ],
    agents: [['a1', 4], ['bad'], 'no', ['a2', 'x']],
    calls: 'no',
  }
  const out = ledgerFrom(rough)!
  expect(out.turns.map(r => r.ord)).toEqual([4, 5])
  expect(out.turns[0]).toEqual({
    ord: 4,
    turnId: 'a',
    session: 's',
    startedAt: 1,
    prompt: 'x'.repeat(60),
    new: [{ k: 'k', c: 'c', r: 'created' }],
    seen: [],
    moreNew: 3,
  })
  expect(out.turns[1]).toMatchObject({
    end: 'refusal',
    endedAt: 9,
    seen: [{ k: 'z', c: 'c', r: 'read', late: true }],
    moreSeen: 2,
    wakes: 1,
  })
  expect(out.next).toBe(6) // past the newest record
  expect(out.agents).toEqual([['a1', 4]])
  expect(out.calls).toEqual([])
  const huge = {
    next: 1,
    turns: Array.from({ length: 70 }, (_, i) => ({ ord: i + 1, turnId: `t${i}`, session: 's', startedAt: i })),
  }
  expect(ledgerFrom(huge)!.turns).toHaveLength(MAX_TURNS)
})

test('R7: joinLedgers puts a stored ledger under the live one: the live record of a turn wins, the counters go on', () => {
  const live = open(emptyLedger(), 't3', 'live')
  const stored = { ...persisted(runA()), next: 9 } as TurnLedger
  const joined = joinLedgers(
    { ...live, turns: [{ ...live.turns[0]!, ord: 5 }], next: 6 },
    { ...stored, turns: [...stored.turns, { ...live.turns[0]!, ord: 5, prompt: 'older copy' }] },
  )
  expect(joined.turns.map(r => [r.ord, r.prompt])).toEqual([
    [1, PROMPT],
    [5, 'live'],
  ])
  expect(joined.next).toBe(9)
  expect(joined.open).toEqual({ ord: 1, turnId: 't3' }) // the running turn of the live ledger stays
  expect(joined.agents).toEqual([[AGENT, 1]])
  expect(joined.calls).toEqual([['tu_agent1_main2', 1]])
  expect(joinLedgers(emptyLedger(), persisted(runA())).turns).toHaveLength(1)
  const many = Array.from({ length: MAX_TURNS }, (_, i) => ({ ...live.turns[0]!, turnId: `a${i}`, ord: i + 100 }))
  expect(joinLedgers({ ...emptyLedger(), turns: many }, persisted(runA())).turns).toHaveLength(MAX_TURNS)
})

test('R7: joinLedgers with agent and call pairs on both sides: the live pair of a key wins, the stored-only pairs go first and fall to the cap first', () => {
  const live: TurnLedger = {
    ...emptyLedger(),
    agents: [
      ['a1', 5],
      ['a2', 6],
    ],
    calls: [['c1', 5]],
  }
  const stored: TurnLedger = {
    ...emptyLedger(),
    agents: [
      ['a1', 1],
      ['a3', 2],
    ],
    calls: [
      ['c1', 1],
      ['c2', 2],
    ],
  }
  const joined = joinLedgers(live, stored)
  expect(joined.agents).toEqual([
    ['a3', 2],
    ['a1', 5],
    ['a2', 6],
  ])
  expect(joined.calls).toEqual([
    ['c2', 2],
    ['c1', 5],
  ])
  // The cap keeps the newest pairs: the live ones, so a stored-only pair is the first to go.
  const full = Array.from({ length: MAX_MAPPED }, (_, i) => [`live${i}`, 7] as const)
  const capped = joinLedgers({ ...emptyLedger(), agents: full, calls: full }, stored)
  expect(capped.agents).toEqual(full)
  expect(capped.calls).toEqual(full)
})

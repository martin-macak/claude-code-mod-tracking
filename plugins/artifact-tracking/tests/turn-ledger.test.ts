// The turn ledger through the whole manager over fakePorts (issue #69): the real item host, the real trackers, the real
// slot. The events come in the orders a live run showed (design study, comment 2): the person's prompt row before its
// `turn.start`, a subagent that works on after its turn, a task notice that wakes the main loop, an aborted end.
import { expect, test } from 'claude-code/testing'
import { TurnLedgerService } from '../core/infra/turn-ledger'
import type { Json } from '../core/interfaces/items'
import type { TurnLedger, TurnRecord } from '../core/interfaces/turns'
import { countOf } from '../core/lib/turn-entries'
import { emptyLedger } from '../core/lib/turns'
import { fakeConfig } from './fixtures/config-fs'
import { promptRow, responseRow, toolResultRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { BG_START_ASYNC_AGENT, BG_START_MAIN, MONITOR_START } from './fixtures/notices'

const A = 'https://docs.example/a'
const B = 'https://docs.example/b'
const C = 'https://docs.example/c'
// A tool result is read for explicit GitHub and Jira URLs only (urls-only), so a `read` needs one of those.
const GH = 'https://github.com/acme/web/issues/9'
const NOTICE =
  '<task-notification>\n<task-id>afe3f3796716e44ee</task-id>\n<tool-use-id>tu_agent1_main2</tool-use-id>\ndone'

function world(o: Parameters<typeof managerWorld>[0] = {}) {
  const t = managerWorld(o)
  const { m, w } = t
  const ledger = () => (w.state.get('turns') as unknown as TurnLedger | undefined) ?? emptyLedger()
  const rec = (ord: number): TurnRecord => ledger().turns.find(r => r.ord === ord)!
  const row = (ev: Parameters<typeof m.row>[1]) => m.row(w.ports, ev)
  const start = (turnId: string, text = '') => m.turnStart(w.ports, { turnId, text })
  const end = (turnId: string, reason = 'answer') =>
    m.turnComplete(w.ports, {
      input: { turnId, reason, isAborted: reason === 'aborted', durationMs: 5, answer: '' } as Json,
    })
  const spawn = (agentId: string, toolUseId: string) =>
    m.agentSpawn(w.ports, { input: { tool_use_id: toolUseId, background: true } as Json, answer: { agentId } as Json })
  const keyOf = (url: string) => t.items().find(r => r.url === url)!.key
  const stamps = (url: string) => {
    const r = t.items().find(i => i.url === url) as unknown as { firstTurn?: number; lastTurn?: number } | undefined
    return r === undefined ? undefined : [r.firstTurn, r.lastTurn]
  }
  const text = async (args: string) => (await m.track(w.ports, args)).text
  return { ...t, ledger, rec, row, start, end, spawn, keyOf, stamps, text }
}

test('R1, R2: the prompt row comes before turn.start; its item waits, carries the next ordinal and lands in the turn that opens', async () => {
  const t = world()
  await t.row(promptRow(`look at ${A}`))
  expect(t.ledger().pending).toMatchObject({ ord: 1, new: [{ c: 'web', r: 'mentioned' }] })
  expect(t.stamps(A)).toEqual([1, 1]) // stamped with the ordinal the turn will get
  await t.start('turn-1', `look at ${A}`)
  expect(t.ledger().pending).toBeUndefined()
  expect(t.ledger().open).toEqual({ ord: 1, turnId: 'turn-1' })
  expect(t.rec(1)).toMatchObject({ ord: 1, turnId: 'turn-1', session: 'sess-1', prompt: `look at ${A}` })
  expect(t.rec(1).new.map(e => e.k)).toEqual([t.keyOf(A)])
  await t.row(responseRow(`and ${B}`))
  await t.end('turn-1')
  expect(t.rec(1).new.map(e => e.k)).toEqual([t.keyOf(A), t.keyOf(B)])
  expect(t.rec(1)).toMatchObject({ end: 'answer' })
  expect(t.ledger().open).toBeUndefined()
  expect(t.stamps(B)).toEqual([1, 1])
})

test('R1: a response row, a tool result and a tool call of the running turn go to it, each with its reason', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.row(responseRow(`wrote ${A}`))
  await t.row(toolResultRow(`fetched ${GH}`))
  await t.end('turn-1')
  expect(t.rec(1).new).toEqual([
    { k: t.keyOf(A), c: 'web', r: 'mentioned' },
    { k: t.keyOf(GH), c: 'github', r: 'read' },
  ])
})

test('R5: the next turn lists the known item it saw again, and what it added; the item keeps its first and takes the last turn', async () => {
  const t = world()
  await t.row(promptRow(`see ${A}`))
  await t.start('turn-1', 'see')
  await t.end('turn-1')
  await t.row(promptRow(`again ${A} and ${B}`))
  await t.start('turn-2', 'again')
  await t.row(responseRow(`${A} once more`))
  await t.end('turn-2')
  expect(t.rec(2).new.map(e => e.k)).toEqual([t.keyOf(B)])
  expect(t.rec(2).seen).toEqual([{ k: t.keyOf(A), c: 'web', r: 'mentioned' }]) // listed once
  expect(t.stamps(A)).toEqual([1, 2])
  expect(t.stamps(B)).toEqual([2, 2])
})

test('R5: a key added and named again in one turn stays in new with the stronger reason; the weaker one does not lower it', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.row(toolResultRow(`read ${GH}`))
  await t.row(responseRow(`now ${GH}`)) // mentioned: weaker than read
  await t.end('turn-1')
  expect(t.rec(1).new).toEqual([{ k: t.keyOf(GH), c: 'github', r: 'read' }])
  expect(t.rec(1).seen).toEqual([])
})

test("R5: a tracker's own items.track makes no entry and no stamp; a status refresh makes none either", async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.row(responseRow(`first ${A}`))
  const lane = t.rt.scan(B, { mode: 'full', purpose: 'capture' }) // the claims the PR lane would push
  await t.rt.track(lane)
  await t.end('turn-1')
  expect(t.keyOf(B)).toBeDefined()
  expect(t.stamps(B)).toEqual([undefined, undefined])
  expect(t.rec(1).new.map(e => e.k)).toEqual([t.keyOf(A)])
  expect(t.rec(1).seen).toEqual([])
  const before = JSON.stringify(t.ledger())
  t.rt.refresh()
  await t.m.tick()
  expect(JSON.stringify(t.ledger())).toBe(before)
})

const urls = (n: number, tag = 'p') => Array.from({ length: n }, (_, i) => `https://docs.example/${tag}${i}`)

test('R7: a turn that adds 60 items and names them again lists no seen entry and counts moreNew 10', async () => {
  const t = world()
  const sixty = urls(60)
  await t.start('turn-1', 'go')
  await t.row(responseRow(`list ${sixty.join(' ')}`))
  await t.row(responseRow(`again ${sixty.join(' ')}`)) // none was known before the turn
  await t.end('turn-1')
  expect(t.items()).toHaveLength(60)
  expect(t.rec(1).new).toHaveLength(50)
  expect(t.rec(1)).toMatchObject({ moreNew: 10, seen: [] })
  expect(t.rec(1).moreSeen).toBeUndefined()
  expect(countOf(t.rec(1))).toEqual({ added: 60, seen: 0 })
  expect(await t.text('turn')).toContain('60 new')
  expect(await t.text('turn')).not.toContain('seen again')
})

test('R7: one known item that does not fit the seen list and is named three times counts once', async () => {
  const t = world()
  const fiftyOne = urls(51)
  await t.start('turn-1', 'go')
  await t.row(responseRow(`list ${fiftyOne.join(' ')}`))
  await t.end('turn-1')
  await t.start('turn-2', 'again')
  await t.row(responseRow(`seen ${fiftyOne.join(' ')}`)) // 50 fit, the 51st counts
  await t.row(responseRow(`and ${fiftyOne[50]}`))
  await t.row(responseRow(`and ${fiftyOne[50]} once more`))
  await t.end('turn-2')
  expect(t.rec(2).seen).toHaveLength(50)
  expect(t.rec(2).moreSeen).toBe(1)
  expect(countOf(t.rec(2))).toEqual({ added: 0, seen: 51 })
})

test('R3: work of a subagent goes to the turn that spawned it, also after that turn ended, marked late', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.spawn('afe3f3796716e44ee', 'tu_agent1_main2')
  await t.row(responseRow(`main says ${A}`))
  await t.row({ ...responseRow(`sub says ${B}`), agentId: 'afe3f3796716e44ee' })
  await t.end('turn-1')
  expect(t.rec(1).new.map(e => [e.k, e.late])).toEqual([
    ['ag:afe3f3796716e44ee', undefined], // the agent that the turn spawned is a row of its own (issue #133)
    [t.keyOf(A), undefined],
    [t.keyOf(B), undefined],
  ])
  // The sub works on, past the end of the main turn (probe log L29 to L35), and a second turn is running.
  await t.start('turn-2', 'next')
  await t.row({ ...responseRow(`sub late ${C}`), agentId: 'afe3f3796716e44ee' })
  await t.end('turn-2')
  expect(t.rec(1).new.at(-1)).toEqual({ k: t.keyOf(C), c: 'web', r: 'mentioned', late: true })
  expect(t.rec(2).new).toEqual([])
  expect(t.stamps(C)).toEqual([1, 1])
})

test('R3: an agent id nobody mapped falls back to the running turn, then to the newest turn', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.row({ ...responseRow(`early sub ${A}`), agentId: 'not-yet-mapped' }) // before the spawn answer
  await t.end('turn-1')
  await t.row({ ...responseRow(`later sub ${B}`), agentId: 'not-yet-mapped' })
  expect(t.rec(1).new).toEqual([
    { k: t.keyOf(A), c: 'web', r: 'mentioned' },
    { k: t.keyOf(B), c: 'web', r: 'mentioned', late: true },
  ])
})

test('R4: a tool call of a subagent goes to the turn that spawned it', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.spawn('a1', 'tu_agent')
  await t.end('turn-1')
  // The call of the agent that started a task maps to the turn of the spawn. A fetch of the agent starts none.
  await t.call('WebFetch', { url: A }, { url: A, code: 200 }, { agentId: 'a1', toolUseId: 'tu_sub_fetch' })
  expect(t.ledger().calls).toEqual([['tu_agent', 1]]) // the spawn call only
  await t.call('Bash', { command: 'sleep 1', run_in_background: true }, BG_START_ASYNC_AGENT, {
    agentId: 'a1',
    toolUseId: 'tu_sub_bg',
  })
  expect(t.ledger().calls).toContainEqual(['tu_sub_bg', 1])
})

test('m1: only a call that started a task is mapped: the id of a Read, an Edit or a fetch is not kept', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.call('Read', { file_path: '/x/a.ts' }, { type: 'text' }, { toolUseId: 'tu_read' })
  await t.call('Edit', { file_path: '/x/a.ts' }, {}, { toolUseId: 'tu_edit' })
  const noTask = { ref: 1, result: { stdout: 'a', backgroundTaskId: '' }, text: 'a' } // an empty id is no task
  await t.call('Bash', { command: 'ls' }, noTask, { toolUseId: 'tu_ls' })
  // The engine wraps a result as { ref, result, text }. The task id of a flat object is not where the engine puts it.
  await t.call('Bash', { command: 'sleep 1' }, BG_START_MAIN.result, { toolUseId: 'tu_flat' })
  expect(t.ledger().calls).toEqual([])
  await t.call('Bash', { command: 'sleep 1', run_in_background: true }, BG_START_MAIN, { toolUseId: 'tu_bg' })
  await t.call('Monitor', { command: 'tail -f x' }, MONITOR_START, { toolUseId: 'tu_mon' })
  expect(t.ledger().calls).toEqual([
    ['tu_bg', 1],
    ['tu_mon', 1],
  ])
})

test('R4: a task notice wakes the main loop: no new ordinal, and its work goes to the turn that started the task', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.spawn('afe3f3796716e44ee', 'tu_agent1_main2')
  await t.end('turn-1')
  // The probe order (L39, L40): the notice as a prompt row of origin task-notification, then turn.start with its text.
  await t.row(promptRow(NOTICE, 'task-notification'))
  expect(t.ledger().wake).toEqual({ taskId: 'afe3f3796716e44ee', toolUseId: 'tu_agent1_main2' })
  await t.start('wake-1', NOTICE)
  expect(t.ledger().turns).toHaveLength(1)
  expect(t.ledger().open).toEqual({ ord: 1, turnId: 'wake-1', wake: true })
  await t.row(responseRow(`spare one ${A}`))
  await t.end('wake-1')
  expect(t.rec(1)).toMatchObject({ wakes: 1, end: 'answer' })
  expect(t.rec(1).new.map(e => e.k)).toEqual(['ag:afe3f3796716e44ee', t.keyOf(A)]) // the spawned agent, then the wake's item
  expect(t.stamps(A)).toEqual([1, 1])
  expect(t.ledger().next).toBe(2)
  // The next real prompt is turn 2, not 3.
  await t.row(promptRow('another question'))
  await t.start('turn-2', 'another question')
  expect(t.ledger().open?.ord).toBe(2)
})

test('R4: a wake whose prompt row never came is found by the text of its turn.start', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.spawn('afe3f3796716e44ee', 'tu_agent1_main2')
  await t.end('turn-1')
  await t.start('wake-1', NOTICE)
  expect(t.ledger().open).toEqual({ ord: 1, turnId: 'wake-1', wake: true })
})

test('R4: a background command that a tool call started wakes the turn it ran in, found by the tool call id', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.call('Bash', { command: 'sleep 1', run_in_background: true }, BG_START_MAIN, { toolUseId: 'tu_bg1_main3' })
  await t.end('turn-1')
  await t.row(promptRow('second', 'composer'))
  await t.start('turn-2', 'second')
  await t.end('turn-2')
  const note = '<task-notification>\n<task-id>b7g00b3v2</task-id>\n<tool-use-id>tu_bg1_main3</tool-use-id>'
  await t.start('wake-2', note)
  expect(t.ledger().open).toEqual({ ord: 1, turnId: 'wake-2', wake: true })
})

test('R2: a person who pastes the text of a task notice starts a turn of their own, and its items land there', async () => {
  const t = world()
  await t.row(promptRow(`first ${A}`))
  await t.start('turn-1', `first ${A}`)
  await t.end('turn-1')
  const pasted = `${NOTICE}\nsee ${B}`
  await t.row(promptRow(pasted)) // origin composer: the person's own prompt row
  await t.start('turn-2', pasted)
  await t.row(responseRow(`ok ${C}`))
  await t.end('turn-2')
  expect(t.ledger().open).toBeUndefined()
  expect(t.ledger().next).toBe(3)
  expect(t.rec(1).wakes).toBeUndefined()
  expect(t.rec(2).new.map(e => e.k)).toEqual([t.keyOf(B), t.keyOf(C)])
  expect(t.rec(1).new.map(e => e.k)).toEqual([t.keyOf(A)])
})

test('R1: an aborted turn commits with the engine word aborted, and so do refusal and error', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.end('turn-1', 'aborted')
  await t.start('turn-2', 'go')
  await t.end('turn-2', 'refusal')
  await t.start('turn-3', 'go')
  await t.end('turn-3', 'error')
  expect(t.ledger().turns.map(r => r.end)).toEqual(['aborted', 'refusal', 'error'])
})

test('R1: the end of a subagent turn commits nothing', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.m.turnComplete(t.w.ports, { input: { turnId: 'turn-1', agentId: 'a1', reason: 'answer' } as Json })
  expect(t.ledger().open).toEqual({ ord: 1, turnId: 'turn-1' })
  expect(t.rec(1).end).toBeUndefined()
  await t.m.turnComplete(t.w.ports, { input: { reason: 'answer' } as Json }) // no turn id at all
  expect(t.ledger().open).toEqual({ ord: 1, turnId: 'turn-1' })
})

test('R7: the ledger is a persisted slot of the session copy, without its run state, and it is capped at 50 turns', async () => {
  const t = world()
  for (let i = 1; i <= 52; i++) {
    await t.row(promptRow(`prompt ${i} https://docs.example/p${i}`))
    await t.start(`t${i}`, `prompt ${i}`)
    await t.end(`t${i}`)
  }
  await t.start('t53', 'running')
  await t.m.flushNow()
  const copy = t.w.store.get('v2:s:sess-1') as unknown as { turns: TurnLedger; items: Json[] }
  expect(Object.keys(copy.turns).sort()).toEqual(['agents', 'calls', 'next', 'turns'])
  expect(copy.turns.turns).toHaveLength(50)
  expect(copy.turns.turns[0]!.ord).toBe(4)
  expect(copy.turns.turns.at(-1)!.ord).toBe(53)
  expect(copy.turns.next).toBe(54)
})

test('R7: a session with no turn stores no turns member', async () => {
  const t = world()
  await t.row(promptRow(`see ${A}`))
  await t.m.flushNow()
  const copy = t.w.store.get('v2:s:sess-1') as unknown as Record<string, Json>
  expect('turns' in copy).toBe(false)
})

/** The order of a live /clear or /resume: the end sees the leaving id, the id changes, the engine resets `$.state`. */
async function leave(t: ReturnType<typeof world>, to: string, reason: 'clear' | 'resume'): Promise<void> {
  await t.m.end(t.w.ports, reason, 1500)
  t.w.session.id = to
  t.w.state.delete('turns')
  t.w.state.delete('items')
}

test('R7: /clear carries the ledger and the ordinals go on; the older turns read earlier session', async () => {
  const t = world()
  await t.row(promptRow(`see ${A}`))
  await t.start('turn-1', 'see')
  await t.end('turn-1')
  await leave(t, 'sess-2', 'clear')
  await t.m.entry(t.w.ports)
  expect(t.ledger().turns.map(r => [r.ord, r.session])).toEqual([[1, 'sess-1']])
  await t.row(promptRow(`new session ${B}`))
  await t.start('turn-2', 'new session')
  await t.end('turn-2')
  expect(t.ledger().turns.map(r => [r.ord, r.session])).toEqual([
    [1, 'sess-1'],
    [2, 'sess-2'],
  ])
  expect(await t.text('turn 1')).toContain('Turn 1 (earlier session)')
  expect(await t.text('turn 2')).not.toContain('earlier session')
  expect(t.stamps(A)).toEqual([1, 1]) // the item carried over, with its turn
  expect(t.stamps(B)).toEqual([2, 2])
})

test('R7: /resume loads the stored ledger of the session; the stored ordinals go on', async () => {
  const stored: TurnLedger = {
    next: 8,
    turns: [
      {
        ord: 7,
        turnId: 'old-7',
        session: 'sess-b',
        startedAt: 5,
        end: 'answer',
        prompt: 'what was asked',
        new: [{ k: 'web:docs.example/old', c: 'web', r: 'created' }],
        seen: [],
      },
    ],
    agents: [],
    calls: [],
  }
  const t = world()
  t.w.store.set('v2:s:sess-b', { items: [], turns: stored as unknown as Json } as unknown as Json)
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  await t.m.entry(t.w.ports)
  expect(t.ledger().turns.map(r => r.ord)).toEqual([7])
  expect(t.ledger().next).toBe(8)
  expect(await t.text('turn')).toContain('Turn 7 · answer')
  await t.start('turn-8', 'next')
  expect(t.ledger().open?.ord).toBe(8)
})

test('P2: a loaded ledger asks for a redraw, so the older duration lines draw their strips again; an ordinary change does not', async () => {
  const stored: TurnLedger = {
    ...emptyLedger(),
    next: 2,
    turns: [
      {
        ord: 1,
        turnId: 'old-1',
        session: 'sess-b',
        startedAt: 5,
        end: 'answer',
        durationRow: 'row-old-1',
        new: [{ k: 'web:docs.example/old', c: 'web', r: 'created' }],
        seen: [],
      },
    ],
  }
  const t = world()
  t.w.store.set('v2:s:sess-b', { items: [], turns: stored as unknown as Json } as unknown as Json)
  await t.m.entry(t.w.ports)
  await t.start('turn-live', 'go') // an ordinary change of the ledger
  const before = t.w.ui.invalidated
  await t.end('turn-live')
  expect(t.w.ui.invalidated).toBe(before) // no redraw of its own: the engine redraws what read the state
  await leave(t, 'sess-b', 'resume')
  const again = t.w.ui.invalidated
  await t.m.entry(t.w.ports)
  expect(t.ledger().turns.some(r => r.durationRow === 'row-old-1')).toBe(true)
  expect(t.w.ui.invalidated).toBeGreaterThan(again) // the load asked for one
})

test('R7: a stored ledger that is not well formed loads what is right and no more', async () => {
  const t = world()
  t.w.store.set('v2:s:sess-b', {
    turns: { next: 'x', turns: [{ ord: 'no' }, 3], agents: 1, calls: 2 },
  } as unknown as Json)
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  await t.m.entry(t.w.ports)
  expect(t.ledger().turns).toEqual([])
  expect(t.ledger().next).toBe(1)
})

test('R7: /track clear empties the ledger and the stored copy goes with it', async () => {
  const t = world()
  await t.row(promptRow(`see ${A}`))
  await t.start('turn-1', 'see')
  await t.end('turn-1')
  await t.m.flushNow()
  expect(t.w.store.has('v2:s:sess-1')).toBe(true)
  expect((await t.m.track(t.w.ports, 'clear')).text).toBe('Tracking list cleared.')
  expect(t.ledger()).toEqual(emptyLedger())
  expect(t.w.store.has('v2:s:sess-1')).toBe(false)
  expect(await t.text('turn')).toBe('No turn tracked yet.')
})

test('R7: a fault of the ledger is logged and never stops the capture of the row', async () => {
  const t = world()
  const real = t.w.ports.state.turns.update
  t.w.ports.state.turns.update = async () => {
    throw new Error('refused')
  }
  await t.row(promptRow(`see ${A}`))
  expect(t.keyOf(A)).toBeDefined() // the item was captured
  expect(t.w.logs).toContain('turns: row failed: refused')
  await t.start('turn-1', 'x')
  expect(t.w.logs).toContain('lifecycle: turn start failed in a turn start: refused')
  t.w.ports.state.turns.update = real
})

test('R9: /track turn prints the newest turn, or turn n, with the new and the seen again items and their reasons', async () => {
  const t = world()
  await t.row(promptRow(`fix the flaky test in ${A}`))
  await t.start('turn-1', 'fix')
  await t.row(toolResultRow(`opened ${GH}`))
  await t.end('turn-1')
  await t.row(promptRow(`and ${A} again`))
  await t.start('turn-2', 'again')
  await t.end('turn-2', 'aborted')
  const first = await t.text('turn 1')
  expect(first.split('\n')[0]).toMatch(
    /^Turn 1 · answer · \d\d:\d\d · "fix the flaky test in https:\/\/docs\.example\/a" · 2 new$/,
  )
  expect(first).toMatch(/\n {2}new {4}docs\.example\/a.* {2}mentioned\n {2}new {4}.*#9.* {2}read$/)
  const last = await t.text('turn')
  expect(last.split('\n')[0]).toMatch(
    /^Turn 2 · aborted · \d\d:\d\d · "and https:\/\/docs\.example\/a again" · 1 seen again$/,
  )
  expect(last).toMatch(/\n {2}again {2}docs\.example\/a.* {2}mentioned$/)
  expect(await t.text('TURN  1')).toBe(first)
})

test('R9: /track turn names a turn it has not reached, a turn it dropped and a bad number', async () => {
  const t = world()
  expect(await t.text('turn')).toBe('No turn tracked yet.')
  for (let i = 1; i <= 52; i++) {
    await t.start(`t${i}`, `p${i}`)
    await t.end(`t${i}`)
  }
  expect(await t.text('turn 2')).toBe('Turn 2 is no longer kept (the last 50 turns are, from turn 3).')
  expect(await t.text('turn 99')).toBe('No turn 99 yet. The last is turn 52.')
  for (const bad of ['turn x', 'turn 0', 'turn -1', 'turn 1 2', 'turn 1.5']) {
    expect(await t.text(bad)).toBe('Usage: /track turn [n]')
  }
})

test('R9: /track turn opens no pane and prints no list: it is a reply of text only', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.end('turn-1')
  const opened = t.w.ui.opened
  expect(await t.text('turn')).toContain('Turn 1')
  expect(t.w.ui.opened).toBe(opened)
})

test('R9: /track turn names an item that has no row left by its category and key', async () => {
  const t = world()
  await t.row(promptRow(`see ${A}`))
  await t.start('turn-1', 'see')
  await t.end('turn-1')
  const key = t.keyOf(A)
  await t.m.dismiss(t.w.ports, [key])
  expect(await t.text('turn')).toContain(`web ${key}`)
})

test('R6: a record of a turn reports an open turn as running', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  expect((await t.text('turn')).split('\n')[0]).toMatch(/^Turn 1 · running · /)
})

test('R10: bandTurn is the newest turn that tracked anything, live while it runs; an empty turn adds nothing', async () => {
  const t = world()
  expect(await t.m.bandTurn()).toBeUndefined()
  await t.row(promptRow(`see ${A}`))
  await t.start('turn-1', 'see')
  expect(await t.m.bandTurn()).toEqual({ ord: 1, text: '+1 new', keys: [t.keyOf(A)] })
  await t.row(responseRow(`${B}`))
  await t.end('turn-1')
  await t.start('turn-2', 'nothing here')
  await t.end('turn-2')
  expect(await t.m.bandTurn()).toEqual({ ord: 1, text: '+2 new', keys: [t.keyOf(A), t.keyOf(B)] })
  await t.row(promptRow(`${A} again`))
  await t.start('turn-3', 'again')
  expect(await t.m.bandTurn()).toEqual({ ord: 3, text: '1 seen again', keys: [t.keyOf(A)] })
})

test('P2: bandTurn(ord) is the turn that the open Button of a strip names, not the newest; a turn the ledger does not hold gives none', async () => {
  const t = world()
  await t.row(promptRow(`see ${A}`))
  await t.start('turn-1', 'see')
  await t.end('turn-1')
  await t.row(promptRow(`see ${B}`))
  await t.start('turn-2', 'see')
  await t.end('turn-2')
  await t.start('turn-3', 'nothing here')
  await t.end('turn-3')
  expect(await t.m.bandTurn(1)).toEqual({ ord: 1, text: '+1 new', keys: [t.keyOf(A)] })
  expect(await t.m.bandTurn(2)).toEqual({ ord: 2, text: '+1 new', keys: [t.keyOf(B)] })
  expect(await t.m.bandTurn(3)).toEqual({ ord: 3, text: '', keys: [] }) // an empty turn has a record and no entry
  expect(await t.m.bandTurn(99)).toBeUndefined()
  expect(await t.m.bandTurn()).toMatchObject({ ord: 2 }) // the band keeps the newest turn with entries
})

test('R6: the rows of the pane carry the first and the last turn of each item; an item no turn tracked has none', async () => {
  const t = world()
  await t.row(promptRow(`see ${A}`))
  await t.start('turn-1', 'see')
  await t.end('turn-1')
  await t.row(promptRow(`${A} again`))
  await t.start('turn-2', 'again')
  await t.end('turn-2')
  await t.rt.track(t.rt.scan(B, { mode: 'full', purpose: 'capture' })) // found by a lane: no turn
  const sections = await t.m.paneData(t.w.ports, { selected: null, expanded: new Set() })
  const rows = new Map(sections.flatMap(s => s.rows).map(r => [r.id, r]))
  expect(rows.get(t.keyOf(A))?.turns).toEqual({ first: 1, last: 2 })
  expect(rows.get(t.keyOf(B))).toBeDefined()
  expect(rows.get(t.keyOf(B))?.turns).toBeUndefined()
})

// ---------------------------------------------------------------- what arms a write of the session copy

/** The service over an atom that counts its writes, with a plain count of what it told Persistence. */
function service() {
  let held = emptyLedger()
  const n = { updates: 0, persisted: 0 }
  const svc = new TurnLedgerService({
    // As in the engine, a read gives a copy: a caller cannot compare it with `===`.
    atom: {
      get: async () => structuredClone(held),
      update: async fn => {
        n.updates++
        held = fn(structuredClone(held))
        return structuredClone(held)
      },
    },
    persisted: () => void n.persisted++,
    redraw: () => {},
    sessionId: async () => 'sess-1',
    wall: () => 1,
    log: () => {},
  })
  return { svc, n, ledger: () => held }
}

test('m1: the session copy is rewritten only when a persisted part of the ledger changed', async () => {
  const { svc, n, ledger } = service()
  await svc.rowTarget(promptRow('hello')) // the pending bucket is not stored
  expect(ledger().pending).toBeDefined()
  expect([n.updates, n.persisted]).toEqual([1, 0])
  await svc.start({ turnId: 'turn-1', text: 'hello' }) // a record opens
  expect(n.persisted).toBe(1)
  await svc.callTarget({ tool: 'Read', input: {}, result: {}, toolUseId: 'tu_read' }) // starts no task: no write at all
  expect([n.updates, n.persisted]).toEqual([2, 1])
  await svc.callTarget({ tool: 'Bash', input: {}, result: BG_START_MAIN as unknown as Json, toolUseId: 'tu_bg' }) // the map of calls grows
  expect(n.persisted).toBe(2)
  await svc.spawn({ input: { tool_use_id: 'tu_agent' } as Json, answer: { agentId: 'a1' } as Json }) // so does the map of agents
  expect(n.persisted).toBe(3)
  await svc.note({ ord: 1 }, { added: [{ k: 'k1', c: 'web', r: 'mentioned' }], seen: [] }) // an entry of the record
  expect(n.persisted).toBe(4)
  await svc.complete({ input: { turnId: 'turn-1', reason: 'answer' } as Json }) // the end word
  expect(n.persisted).toBe(5)
  await svc.rowTarget(promptRow('again')) // a bucket again: stored state is as it was
  await svc.rowTarget(promptRow('twice'))
  expect(n.persisted).toBe(5)
})

// ---------------------------------------------------------------- P2: the strip (issue #69, design study S7 to S9)

const DURATION = '05c26614-94d4-4b09-86c3-8ea6738495b2'
/** A world whose config file sets `global.ui.turnStrip`. */
const stripWorld = (mode: string) =>
  world({ config: specs => fakeConfig({ specs, file: { global: { ui: { turnStrip: mode } } } }) })

/**
 * One TUI turn (L86 to L99): prompt row, turn.start, response, then the end. The `turn_duration` row of an answer comes
 * inside `turn.complete`; its hook noted the uuid, and the hook of `turn.complete` hands it to the commit.
 */
async function answered(t: ReturnType<typeof world>, turnId: string, text: string, reason = 'answer') {
  await t.row(promptRow(text))
  await t.start(turnId, text)
  await t.row(responseRow(`ok ${text}`))
  await t.m.turnComplete(t.w.ports, {
    input: { turnId, reason, isAborted: reason === 'aborted', durationMs: 5, answer: '' } as Json,
    ...(reason === 'answer' ? { durationRow: `row-${turnId}` } : {}),
  })
}

test('S9: the commit keeps the uuid of the duration row on the record, and the session copy follows', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.m.turnComplete(t.w.ports, {
    input: { turnId: 'turn-1', reason: 'answer', durationMs: 5, answer: '' } as Json,
    durationRow: DURATION,
  })
  expect(t.rec(1)).toMatchObject({ end: 'answer', durationRow: DURATION })
  expect(JSON.stringify(t.ledger())).toContain(DURATION)
})

test('S9: a turn that ends with no row keeps none, and a subagent end with a row commits nothing', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await t.m.turnComplete(t.w.ports, {
    input: { turnId: 'sub-turn', agentId: 'agent-7', reason: 'answer' } as Json,
    durationRow: 'sub-row',
  })
  expect(t.ledger().open).toEqual({ ord: 1, turnId: 'turn-1' })
  expect(t.rec(1).durationRow).toBeUndefined()
  await t.end('turn-1', 'aborted')
  expect(t.rec(1)).toMatchObject({ end: 'aborted' })
  expect(t.rec(1).durationRow).toBeUndefined()
})

test('R16: with turnStrip text, a turn that tracked something gets one line, and the line names the turn', async () => {
  const t = stripWorld('text')
  await answered(t, 'turn-1', `see ${A} and ${B}`)
  expect(await t.m.turnStrip('turn-1')).toBe('+2 new · /track turn 1')
  await answered(t, 'turn-2', `again ${A} and ${C}`)
  expect(await t.m.turnStrip('turn-2')).toBe('+1 new · 1 seen again · /track turn 2')
  expect(await t.m.turnStrip('turn-2')).not.toContain('updated')
})

test('R16: a turn that tracked nothing, an unknown turn id and the wake of a task get no line', async () => {
  const t = stripWorld('text')
  await answered(t, 'turn-1', 'nothing to see here')
  expect(await t.m.turnStrip('turn-1')).toBeUndefined()
  expect(await t.m.turnStrip('never-heard')).toBeUndefined()
  await answered(t, 'turn-2', 'spawn one')
  await t.spawn('afe3f379', 'tu_agent1_main2')
  const notice = '<task-notification>\n<task-id>afe3f379</task-id>\n<tool-use-id>tu_agent1_main2</tool-use-id>\ndone'
  await t.row(promptRow(notice, 'task-notification'))
  await t.start('wake-1', notice)
  await t.row(responseRow(`spare ${A}`))
  await t.end('wake-1')
  expect(await t.m.turnStrip('wake-1')).toBeUndefined() // its work is in turn 2, which has its own line
})

test('R15: with turnStrip off, and by default, no line is made for any turn', async () => {
  for (const t of [world(), stripWorld('off'), stripWorld('loud')]) {
    await answered(t, 'turn-1', `see ${A}`)
    expect(await t.m.turnStrip('turn-1')).toBeUndefined()
    expect(await t.m.durationStrip('row-turn-1')).toBeUndefined()
  }
})

test('R17: with turnStrip interactive the duration line draws the counts; the text line is left for the turns it cannot carry', async () => {
  const t = stripWorld('interactive')
  await answered(t, 'turn-1', `see ${A} and ${B}`)
  expect(await t.m.durationStrip('row-turn-1')).toEqual({ ord: 1, counts: '+2 new' })
  expect(await t.m.turnStrip('turn-1')).toBeUndefined() // the duration line carries it
  expect(await t.m.durationStrip('row-unknown')).toBeUndefined()
  await answered(t, 'turn-2', `again ${C}`, 'aborted') // an aborted turn has no duration line (L118 to L134)
  expect(await t.m.turnStrip('turn-2')).toBe('+1 new · /track turn 2')
  expect(await t.m.durationStrip('row-turn-2')).toBeUndefined()
})

test('R17: text mode draws nothing on the duration line, even when the turn has a duration row', async () => {
  const t = stripWorld('text')
  await answered(t, 'turn-1', `see ${A}`)
  expect(await t.m.durationStrip('row-turn-1')).toBeUndefined()
})

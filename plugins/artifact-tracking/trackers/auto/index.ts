// The auto tracker: worktrees and agents of this run, found from tool calls, spawns, turn ends and the tick. A round
// (git porcelain, then the engine's agent list) writes the `auto` member of the state family. The slot is run-scoped
// (`persist: false`): the root, the proofs and the dismiss list go to `v2:run`, and a session switch carries them first
// (plan decisions D2, D9).
// It publishes five facts for the readers that cannot wait: `auto.root`, `auto.agents`, `auto.prs`, `auto.checkedAt` and,
// after each round, `auto.branches`. The github tracker starts the PR lane from the last, and reads the PRs the run
// created from `auto.prs`, so auto never calls `gh` (plan L5, Task 12; issue #158).
// A cold `--resume` rebuilds the proofs of the PRs that the main loop created from the replayed transcript (issue #202).
// The tracker is a module constant. What it builds once per load (the round, the scheduler, the count of rounds) is kept
// per load, by the facts of the context.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 10.

import type {
  AgentSpawnEvent,
  CommandEvent,
  ReplayItem,
  StartEvent,
  TickEvent,
  ToolCallEvent,
  TurnCompleteEvent,
} from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Traceable } from '../../core/interfaces/reasons'
import type { FactsPort, Handler, Tracker, TrackerContext } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import { LoadState } from '../../core/lib/load-state'
import { autoCleanup } from './clean'
import { type AutoConfig, autoConfig } from './config'
import { autoIds } from './dismiss'
import { fromAgentResult, fromBash, fromEnterResult, fromSpawn, fromTurnEnd } from './events'
import { FACT_AGENTS, FACT_BRANCHES, FACT_CHECKED_AT, FACT_PRS, FACT_ROOT } from './facts'
import { MASTER_ID } from './ids'
import {
  carryAuto,
  emptyAuto,
  pinRoot,
  recordActivity,
  recordAgentBranch,
  recordAgentResult,
  recordEnter,
  recordPr,
  recordSpawn,
  recordTurnEnd,
} from './ledger'
import { autoReasonsOf } from './reasons'
import { AutoRound } from './round'
import { AutoScheduler } from './scheduler'
import { sections } from './sections'
import { autoTurnsOf, spawnSightings } from './turns'
import type { AutoReason, AutoState, BranchesFact } from './types'

export { autoDismiss } from './dismiss-store'
export { type AutoConfig, autoConfig }

type Ctx = TrackerContext<AutoConfig, AutoState>
type H<E> = Handler<AutoConfig, AutoState, E>
/** What the slot writes need of a context. */
type SlotCtx = Pick<Ctx, 'data' | 'facts'>

export { FACT_AGENTS, FACT_BRANCHES, FACT_CHECKED_AT, FACT_PRS, FACT_ROOT }

/** The run: root, proofs, agents, dismiss list and the last snapshot. A slot never written reads as a fresh empty one. */
const readAuto = async (ctx: Pick<Ctx, 'data'>): Promise<AutoState> => (await ctx.data.get()) ?? emptyAuto()

/**
 * The root, the agent ledger and the PRs the run created as facts, for the readers that cannot wait: the repos tracker,
 * the file ignore rule and the PR lane.
 */
function publishAuto(facts: FactsPort, s: AutoState): void {
  facts.publish(FACT_ROOT, (s.root ?? undefined) as unknown as Json | undefined)
  facts.publish(FACT_AGENTS, s.agents as unknown as Json)
  facts.publish(FACT_PRS, (s.prs ?? []) as unknown as Json)
}

/**
 * The branches of the last snapshot, with the master agent's branch (R7 reads it). Published after each round with a new
 * `seq` and the round's reasons, and at init with the last `seq` and no reasons (plan K20). A restore (a switch) counts
 * as a publish and moves `seq`, so the github tracker sees a changed branch list (plan L5, Task 12).
 */
function publishBranches(facts: FactsPort, s: AutoState, seq: number, reasons: readonly string[]): void {
  const snap = s.snapshot
  const current = snap?.agents.find(a => a.id === MASTER_ID)?.branch
  const fact: BranchesFact = {
    seq,
    reasons,
    ...(current !== undefined ? { current } : {}),
    branches: snap?.branches ?? [],
    overflow: snap?.overflow ?? 0,
  }
  facts.publish(FACT_BRANCHES, fact as unknown as Json)
}

/**
 * Changes the `auto` member. Every write goes through here (A18, A22). It reads first and stops when the change
 * returns its input: no write. Else `update` runs the change on the current value and retries on a version miss.
 * Then the facts follow the slot.
 */
export async function setAuto(ctx: SlotCtx, change: (cur: AutoState) => AutoState): Promise<AutoState> {
  const cur = await readAuto(ctx)
  if (change(cur) === cur) {
    publishAuto(ctx.facts, cur)
    return cur
  }
  const next = (await ctx.data.update(c => change(c ?? emptyAuto()))) ?? cur
  publishAuto(ctx.facts, next)
  return next
}

/** A sign of life for a workflow agent (A7). A main-loop call has no agent id and does nothing. */
async function touch(ctx: Ctx, agentId: string | undefined): Promise<void> {
  if (agentId !== undefined) await setAuto(ctx, s => recordActivity(s, agentId, ctx.clock.wall()))
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * A handler that never rejects: a refused `auto` write or a bad payload must not touch the tool result, and the next
 * event writes again. The fault is logged once.
 */
function soft<E>(what: string, run: H<E>): H<E> {
  return async (ctx, ev) => {
    try {
      await run(ctx, ev)
    } catch (e) {
      ctx.log(`auto: ${what} failed: ${reason(e)}`)
    }
  }
}

type Services = { round: AutoRound; scheduler: AutoScheduler }

/** The rounds this load has run. */
type Tally = { seq: number }

/** What the tracker builds once per load: the count of its rounds, and the round with its scheduler (plan decision D16). */
type Load = { tally: Tally; svc?: Services }

const loads = new LoadState<Load>()
const loadOf = (ctx: Ctx): Load => loads.of(ctx, () => ({ tally: { seq: 0 } }))

/** Kicks the scheduler of this load. Before `init` there is none. */
const kick = (ctx: Ctx, why: AutoReason): void => loads.get(ctx)?.svc?.scheduler.kick(why)

/** The round and its scheduler. The deps are plain closures over the context of the first hook of the load. */
function build(ctx: Ctx, tally: Tally): Services {
  const round = new AutoRound({
    now: () => ctx.clock.wall(),
    load: async () => {
      const s = await readAuto(ctx)
      publishAuto(ctx.facts, s)
      return s
    },
    save: change => setAuto(ctx, change),
    git: (argv, cwd) => ctx.tools.run('git', ['git', ...argv], { cwd, timeoutMs: ctx.config.slice().gitTimeoutMs }),
    // The caps are read at each step, so a changed file shows at the next round.
    caps: () => ctx.config.slice(),
    listAgents: async () =>
      (await ctx.env.agents()).map(a => ({
        id: a.id,
        status: a.status,
        ...(a.teammateId !== undefined ? { teammateId: a.teammateId } : {}),
      })),
    sessionCwd: () => ctx.session.cwd(),
  })
  const scheduler = new AutoScheduler({
    now: () => ctx.clock.wall(),
    after: (ms, fn) => ctx.clock.after(ms, fn),
    debounceMs: () => ctx.config.slice().debounceMs,
    run: async reasons => {
      const ran = await round.run()
      ctx.facts.publish(FACT_CHECKED_AT, ctx.clock.wall()) // the Worktrees note reads it before `snapshot.at` (A22)
      // A round with no run behind it (a lazy start has no root) polled nothing. Its empty branch list would start a PR
      // step that only writes a `no-branches` note, and the old round never started one there (spec 10.4, K31).
      if (!ran) return
      tally.seq++
      publishBranches(ctx.facts, await readAuto(ctx), tally.seq, [...reasons])
    },
  })
  return { round, scheduler }
}

// The root is pinned at the first start of the run. A lazy start has no cwd and pins nothing.
const onStart: H<StartEvent> = soft('start', async (ctx, ev) => {
  const cwd = ev.cwd
  if (cwd === undefined) return
  try {
    await setAuto(ctx, s => pinRoot(s, cwd, ctx.clock.wall())) // A3: a later start (a reload) keeps the pinned root
  } finally {
    kick(ctx, 'start')
  }
})

const onEnter: H<ToolCallEvent> = soft('EnterWorktree', async (ctx, ev) => {
  const f = fromEnterResult(ev.result, ev.agentId)
  if (f) await setAuto(ctx, s => recordEnter(s, f, ctx.clock.wall(), ctx.config.slice().maxProofs))
  await touch(ctx, ev.agentId)
  kick(ctx, 'worktree')
})

// The next round marks the child removed (remove) or keeps it live (keep).
const onExit: H<ToolCallEvent> = soft('ExitWorktree', async (ctx, ev) => {
  await touch(ctx, ev.agentId)
  kick(ctx, 'worktree')
})

const onAgent: H<ToolCallEvent> = soft('Agent', async (ctx, ev) => {
  const f = fromAgentResult(ev.result)
  if (f?.worktreePath !== undefined)
    await setAuto(ctx, s => recordAgentResult(s, f, ctx.clock.wall(), ctx.config.slice().maxProofs))
  await touch(ctx, ev.agentId)
  kick(ctx, 'agent')
})

const onBash: H<ToolCallEvent> = soft('Bash', async (ctx, ev) => {
  const command = String(isRecord(ev.input) ? (ev.input.command ?? '') : '')
  const f = fromBash(command, ev.result, ev.agentId)
  const { agentId, branch, pr } = f
  if (agentId !== undefined && branch !== undefined) await setAuto(ctx, s => recordAgentBranch(s, agentId, branch))
  // A PR the run created is a proof, written before the kick: the round that `pr-event` starts opens the PR step, and
  // the fact `auto.prs` already holds it (issue #158).
  if (pr !== undefined) await setAuto(ctx, s => recordPr(s, pr, ctx.config.slice().maxProofs))
  await touch(ctx, ev.agentId)
  if (f.kick) kick(ctx, f.kick)
})

// A `--resume` fires no hook for the old calls: the transcript comes back as one batch (core/infra/replay.ts). The stored
// result of a Bash call keeps `gitOperation` (observed, issue #202), so `fromBash` reads a replayed use as it reads a live
// answer, and a PR that the earlier process created is a proof again. The `kick` that `fromBash` gives for an item is not
// used: a replayed merge, comment or `git worktree` command must not start a round. One `pr-event` follows a write that
// added a proof instead. The start round can run before the replay ends (a slow read), and its PR step then has no proof
// to ask for: this kick makes the next step ask for the created PRs. When the run held every proof already (a carry),
// the first round asked for them, so there is no kick. A call of a subagent is not in this transcript (its own
// transcript has no result), and a call from before the last `/compact` or past the newest 4096 messages is gone.
const onReplay: H<readonly ReplayItem[]> = soft('replay', async (ctx, batch) => {
  const found = batch.flatMap(item => {
    if (item.kind !== 'toolCall' || item.ev.tool !== 'Bash') return []
    // `command` only feeds the `git` kick, which a replay drops. `pr` reads the stored `gitOperation` of the whole use.
    const { pr } = fromBash('', item.ev.result)
    return pr === undefined ? [] : [pr]
  })
  if (found.length === 0) return
  const max = ctx.config.slice().maxProofs
  let grew = false
  await setAuto(ctx, s => {
    const next = found.reduce((acc, pr) => recordPr(acc, pr, max), s) // oldest first: the newest `max` stay
    grew = next !== s // the last run is the one that wrote
    return next
  })
  if (grew) kick(ctx, 'pr-event')
})

// Monitor, TaskStop and the file tools only count as a sign of life.
const onTouch: H<ToolCallEvent> = soft('touch', (ctx, ev) => touch(ctx, ev.agentId))

const onSpawn: H<AgentSpawnEvent> = soft('agent.spawn', async (ctx, ev) => {
  const f = fromSpawn(ev.input, ev.answer)
  if (f) {
    const turn = ctx.turn
    let before: AutoState | undefined
    await setAuto(ctx, s => {
      before = s // the last run is the one that wrote
      return recordSpawn(s, f, ctx.clock.wall(), ev.sessionCwd, ctx.config.slice().maxAgents, turn?.ord)
    })
    // A workflow run spawns many agents: each is stamped, and the run is one entry of its turn (issue #203). A per-agent entry
    // would fill the 50 entries of the turn.
    if (turn !== undefined && before !== undefined) await turn.note(spawnSightings(turn.ord, f, before))
  }
  kick(ctx, 'agent')
})

const onTurn: H<TurnCompleteEvent> = soft('turn.complete', async (ctx, ev) => {
  const f = fromTurnEnd(ev.input) // a main-loop turn has no agent id and no fact
  if (!f) return
  const at = ctx.clock.wall()
  await setAuto(ctx, s => recordTurnEnd(recordActivity(s, f.agentId, at), f.agentId, f.reason, at))
  kick(ctx, 'agent')
})

const onTick: H<TickEvent> = ctx => kick(ctx, 'tick')

// `/track clear` hides the current auto items first, so the next tick does not bring them back (A14). `/track
// refresh` runs a round at once, and with `wait` the command answers when the round is done. The github tracker
// waits for its PR step after this (order 30), because the fact this round publishes started that step.
const onCommand: H<CommandEvent> = async (ctx, ev) => {
  if (ev.sub === 'clear') {
    const ids = autoIds(await readAuto(ctx), await ctx.items.list())
    await ctx.dismiss.add(ids)
  } else if (ev.sub === 'refresh') {
    kick(ctx, 'manual')
    if (ev.wait) await loads.get(ctx)?.svc?.scheduler.idle()
  } else if (ev.sub === 'manual') kick(ctx, 'manual')
}

export const auto: Tracker<AutoConfig, AutoState> & Traceable<AutoState> = {
  id: 'auto',
  order: 10,
  persist: false,
  config: autoConfig,
  init: async ctx => {
    const load = loadOf(ctx)
    load.svc ??= build(ctx, load.tally)
    try {
      // A hot reload keeps the plugin state and loses the facts: publish what the slot holds.
      const s = await readAuto(ctx)
      publishAuto(ctx.facts, s)
      publishBranches(ctx.facts, s, load.tally.seq, [])
    } catch {
      // The first write or the first round publishes them.
    }
  },
  store: ctx => ctx.config.slice(),
  data: {
    // A switch carries the root, the proofs and the dismiss list into the new state (A18). The restore is a publish of
    // the branches too, so it moves `seq` and the github tracker sees a changed branch list.
    restore: async (ctx, value) => {
      const s = await setAuto(ctx, cur => carryAuto(value, cur))
      publishBranches(ctx.facts, s, ++loadOf(ctx).tally.seq, [])
    },
  },
  sections,
  cleanup: autoCleanup,
  reasonsOf: autoReasonsOf,
  turnsOf: autoTurnsOf,
  events: {
    start: onStart,
    toolCall: {
      EnterWorktree: onEnter,
      ExitWorktree: onExit,
      Agent: onAgent,
      Bash: onBash,
      Monitor: onTouch,
      TaskStop: onTouch,
      Write: onTouch,
      Edit: onTouch,
      Read: onTouch,
    },
    agentSpawn: onSpawn,
    turnComplete: onTurn,
    replay: onReplay,
    tick: { run: onTick },
    command: onCommand,
  },
}

// The auto tracker: worktrees, agents and pull requests of this run, found from tool calls, spawns, turn ends and the
// tick. A round (git porcelain, the engine's agent list, then the PR step in its own lane) writes the `auto` member of
// the state family. The slot is run-scoped (`persist: false`): the root, the proofs and the dismiss list go to
// `v2:run`, and a session switch carries them first (plan decisions D2, D9).
// It publishes four facts for the readers that cannot wait: `auto.root`, `auto.agents`, `auto.checkedAt` and, after each
// round, `auto.branches`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 10.

import { autoIds } from '../../core/infra/dismiss'
import type {
  AgentSpawnEvent,
  CommandEvent,
  StartEvent,
  TickEvent,
  ToolCallEvent,
  TurnCompleteEvent,
} from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { FactsPort, Handler, Tracker, TrackerContext } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import type {
  AutoReason,
  AutoState,
  DiscoveryApplied,
  GitHubDiscoveryApi,
  ItemRecord,
  RepoRef,
} from '../../hooks/contracts'
import { MASTER_ID } from '../../hooks/contracts'
import { type AutoConfig, autoConfig } from './config'
import { fromAgentResult, fromBash, fromEnterResult, fromSpawn, fromTurnEnd } from './events'
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
} from './ledger'
import { type AutoLane, AutoRound } from './round'
import { AutoScheduler } from './scheduler'
import type { BranchesFact } from './types'

/**
 * What the PR lane of the round needs from github. Injected, because the GitHub tool and the session repo belong to
 * the item host until layer L5b moves the PR lane to the github tracker (plan decision D13).
 */
export type AutoGithub = {
  discovery: GitHubDiscoveryApi
  /** Waits for the cached `gh --version` probe. */
  ready(): Promise<boolean>
  /** The session repo, after it was looked up. null: none. */
  repo(): Promise<RepoRef | null>
  hosts(): readonly string[]
  /**
   * The github values of the PR lane, read at each call: a changed config file shows at the next round. The auto
   * tracker does not import the github folder, so the lane is spelled here (plan decision C15, layer L5 gives it one owner).
   */
  lane(): AutoLane
}

export { type AutoConfig, autoConfig }

type Ctx = TrackerContext<AutoConfig, AutoState>
type H<E> = Handler<AutoConfig, AutoState, E>
/** What the slot writes need of a context. */
type SlotCtx = Pick<Ctx, 'data' | 'facts'>

/** The facts of this tracker. */
export const FACT_ROOT = 'auto.root'
export const FACT_AGENTS = 'auto.agents'
export const FACT_CHECKED_AT = 'auto.checkedAt'
export const FACT_BRANCHES = 'auto.branches'

/** The run: root, proofs, agents, dismiss list and the last snapshot. A slot never written reads as a fresh empty one. */
const readAuto = async (ctx: Pick<Ctx, 'data'>): Promise<AutoState> => (await ctx.data.get()) ?? emptyAuto()

/** The root and the agent ledger as facts, for the readers that cannot wait: the repos tracker and the file ignore rule. */
function publishAuto(facts: FactsPort, s: AutoState): void {
  facts.publish(FACT_ROOT, (s.root ?? undefined) as unknown as Json | undefined)
  facts.publish(FACT_AGENTS, s.agents as unknown as Json)
}

/**
 * The branches of the last snapshot, with the master agent's branch (R7 reads it). Published after each round with a new
 * `seq` and the round's reasons, and at init and after a restore with the last `seq` and no reasons (plan K20).
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

/** The rounds this load has run. It lives as long as the tracker, which is built once per load. */
type Tally = { seq: number }

/** The round and its scheduler. The deps are plain closures over the context of the first hook of the load. */
function build(ctx: Ctx, gh: AutoGithub, tally: Tally): Services {
  const round = new AutoRound({
    now: () => ctx.clock.wall(),
    load: async () => {
      const s = await readAuto(ctx)
      publishAuto(ctx.facts, s)
      return s
    },
    save: change => setAuto(ctx, change),
    git: (argv, cwd) => ctx.tools.run('git', ['git', ...argv], { cwd, timeoutMs: ctx.config.slice().gitTimeoutMs }),
    // The caps are read at each step, so a changed file shows at the next round. The staleMs and maxItems are global.
    caps: () => {
      const g = ctx.config.global()
      return { ...ctx.config.slice(), staleMs: g.refresh.staleMs, maxItems: g.store.maxItems, lane: gh.lane() }
    },
    listAgents: async () =>
      (await ctx.env.agents()).map(a => ({
        id: a.id,
        status: a.status,
        ...(a.teammateId !== undefined ? { teammateId: a.teammateId } : {}),
      })),
    sessionCwd: () => ctx.session.cwd(),
    repo: () => gh.repo(),
    gh: gh.discovery,
    ghReady: () => gh.ready(),
    githubHosts: () => gh.hosts(),
    // The store runs the session check and reads the dismiss list, then calls `change` (maybe twice). The result of
    // the last call is what the round reports.
    applyItems: async change => {
      let result: DiscoveryApplied | undefined
      await ctx.items.update((list, dismissed) => {
        result = change(list as unknown as ItemRecord[], dismissed)
        return result.list
      })
      if (!result) throw new Error('the item write did not run')
      return result
    },
    onAdded: keys => {
      if (keys.length > 0) ctx.items.refresh(keys)
    },
  })
  const scheduler = new AutoScheduler({
    now: () => ctx.clock.wall(),
    after: (ms, fn) => ctx.clock.after(ms, fn),
    debounceMs: () => ctx.config.slice().debounceMs,
    run: async reasons => {
      await round.run(reasons)
      ctx.facts.publish(FACT_CHECKED_AT, ctx.clock.wall()) // the Worktrees note reads it before `snapshot.at` (A22)
      tally.seq++
      publishBranches(ctx.facts, await readAuto(ctx), tally.seq, [...reasons])
    },
  })
  return { round, scheduler }
}

/** The tracker is built once per load, so the round and the scheduler live as long as the load (plan decision D16). */
export function autoTracker(gh: AutoGithub): Tracker<AutoConfig, AutoState> {
  let svc: Services | undefined
  const tally: Tally = { seq: 0 }
  const kick = (why: AutoReason): void => svc?.scheduler.kick(why)

  // The root is pinned at the first start of the run. A lazy start has no cwd and pins nothing.
  const onStart: H<StartEvent> = soft('start', async (ctx, ev) => {
    const cwd = ev.cwd
    if (cwd === undefined) return
    try {
      await setAuto(ctx, s => pinRoot(s, cwd, ctx.clock.wall())) // A3: a later start (a reload) keeps the pinned root
    } finally {
      kick('start')
    }
  })

  const onEnter: H<ToolCallEvent> = soft('EnterWorktree', async (ctx, ev) => {
    const f = fromEnterResult(ev.result, ev.agentId)
    if (f) await setAuto(ctx, s => recordEnter(s, f, ctx.clock.wall(), ctx.config.slice().maxProofs))
    await touch(ctx, ev.agentId)
    kick('worktree')
  })

  // The next round marks the child removed (remove) or keeps it live (keep).
  const onExit: H<ToolCallEvent> = soft('ExitWorktree', async (ctx, ev) => {
    await touch(ctx, ev.agentId)
    kick('worktree')
  })

  const onAgent: H<ToolCallEvent> = soft('Agent', async (ctx, ev) => {
    const f = fromAgentResult(ev.result)
    if (f?.worktreePath !== undefined)
      await setAuto(ctx, s => recordAgentResult(s, f, ctx.clock.wall(), ctx.config.slice().maxProofs))
    await touch(ctx, ev.agentId)
    kick('agent')
  })

  const onBash: H<ToolCallEvent> = soft('Bash', async (ctx, ev) => {
    const command = String(isRecord(ev.input) ? (ev.input.command ?? '') : '')
    const f = fromBash(command, ev.result, ev.agentId)
    const { agentId, branch } = f
    if (agentId !== undefined && branch !== undefined) await setAuto(ctx, s => recordAgentBranch(s, agentId, branch))
    await touch(ctx, ev.agentId)
    if (f.kick) kick(f.kick)
  })

  // Monitor, TaskStop and the file tools only count as a sign of life.
  const onTouch: H<ToolCallEvent> = soft('touch', (ctx, ev) => touch(ctx, ev.agentId))

  const onSpawn: H<AgentSpawnEvent> = soft('agent.spawn', async (ctx, ev) => {
    const f = fromSpawn(ev.input, ev.answer)
    if (f) await setAuto(ctx, s => recordSpawn(s, f, ctx.clock.wall(), ev.sessionCwd, ctx.config.slice().maxAgents))
    kick('agent')
  })

  const onTurn: H<TurnCompleteEvent> = soft('turn.complete', async (ctx, ev) => {
    const f = fromTurnEnd(ev.input) // a main-loop turn has no agent id and no fact
    if (!f) return
    const at = ctx.clock.wall()
    await setAuto(ctx, s => recordTurnEnd(recordActivity(s, f.agentId, at), f.agentId, f.reason, at))
    kick('agent')
  })

  const onTick: H<TickEvent> = () => kick('tick')

  // `/track clear` hides the current auto items first, so the next tick does not bring them back (A14). `/track
  // refresh` runs a round at once, and with `wait` the command answers when the round and its PR step are done.
  const onCommand: H<CommandEvent> = async (ctx, ev) => {
    if (ev.sub === 'clear') {
      const ids = autoIds(await readAuto(ctx), (await ctx.items.list()) as unknown as ItemRecord[])
      await ctx.dismiss.add(ids)
    } else if (ev.sub === 'refresh') {
      kick('manual')
      if (ev.wait && svc) {
        await svc.scheduler.idle()
        await svc.round.idle()
      }
    } else if (ev.sub === 'manual') kick('manual')
  }

  return {
    id: 'auto',
    order: 10,
    persist: false,
    config: autoConfig,
    init: async ctx => {
      svc ??= build(ctx, gh, tally)
      try {
        // A hot reload keeps the plugin state and loses the facts: publish what the slot holds.
        const s = await readAuto(ctx)
        publishAuto(ctx.facts, s)
        publishBranches(ctx.facts, s, tally.seq, [])
      } catch {
        // The first write or the first round publishes them.
      }
    },
    store: ctx => ctx.config.slice(),
    data: {
      // A switch carries the root, the proofs and the dismiss list into the new state (A18).
      restore: async (ctx, value) => {
        const s = await setAuto(ctx, cur => carryAuto(value, cur))
        publishBranches(ctx.facts, s, tally.seq, [])
      },
    },
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
      tick: { run: onTick },
      command: onCommand,
    },
  }
}

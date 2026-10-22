// The repos tracker: the git repositories the session reads from or edits, found from Bash commands, file tools and
// spawn cwds. It looks each one up off the hook path (a queue, one job at a time) and keeps its rows in its own slot.
// It reads the session root and the agent labels from the facts `auto.root` and `auto.agents`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 9.

import type { AgentSpawnEvent, DismissedEvent, ToolCallEvent } from '../../core/interfaces/events'
import type { RepoRef } from '../../core/interfaces/ports'
import type { Traceable } from '../../core/interfaces/reasons'
import type { Handler, Tracker, TrackerContext } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import { LoadState } from '../../core/lib/load-state'
import { type ReposConfig, reposConfig } from './config'
import { extractRepoPathsFromTool, PATH_TOOLS, parseRepoHintsFromBash, type RepoHit, repoBaseDir } from './hints'
import { repoRowId } from './ids'
import { RepoQueue } from './queue'
import { repoReasonsOf } from './reasons'
import { asRepoRows, capRepoRows, mergeRepoRows, upsertRepoRows } from './rows'
import { sections } from './sections'
import { RepoTracker, type RepoVisit } from './tracker'
import { repoSightings, repoTurnsOf } from './turns'
import type { AgentFact, RepoRecord, RootFact } from './types'

export { asRepoRows, type ReposConfig, reposConfig }

type Ctx = TrackerContext<ReposConfig, RepoRecord[]>
type H<E> = Handler<ReposConfig, RepoRecord[], E>
/** What the row writes need of a context. */
type RowsCtx = Pick<Ctx, 'data' | 'dismiss' | 'config'>

/**
 * Changes the rows in the slot. Every write goes through here, so this is the one place that drops the repos the
 * person dismissed with the x button. It drops them before the cap. Reads first and writes nothing when the result is
 * the input list itself. `since` is a generation: an older one drops the write (plan decision D8).
 */
export async function setRepos(
  ctx: RowsCtx,
  change: (rows: RepoRecord[]) => RepoRecord[],
  since?: number,
): Promise<void> {
  const dismissed = await ctx.dismiss.list()
  const apply = (rows: RepoRecord[]): RepoRecord[] => {
    const out = change(rows)
    const kept = dismissed.size === 0 ? out : out.filter(r => !dismissed.has(repoRowId(r.key)))
    return capRepoRows(kept.length === out.length ? out : kept, ctx.config.slice())
  }
  const cur = asRepoRows(await ctx.data.get())
  if (apply(cur) === cur) return // nothing changed: no write, no flush
  await ctx.data.update(c => apply(asRepoRows(c)), since !== undefined ? { since } : undefined)
}

/** A `tool.call` result of a call that was refused (`deny`) or that the tool reported as an error (`isError`). */
const refused = (ran: unknown): boolean => isRecord(ran) && ran.deny !== undefined
const failed = (ran: unknown): boolean => refused(ran) || (isRecord(ran) && ran.isError === true)

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const agentsOf = (ctx: Pick<Ctx, 'facts'>): readonly AgentFact[] =>
  (ctx.facts.read('auto.agents') as unknown as AgentFact[] | undefined) ?? []

/** The label of the loop that touched a repo: the main loop, the agent's label, or `agent:` and the start of its id. */
function touchedBy(ctx: Pick<Ctx, 'facts'>, agentId: string | undefined): string {
  if (agentId === undefined) return 'main'
  const label = agentsOf(ctx).find(a => a.id === agentId)?.label
  return label && label !== '' ? label : `agent:${agentId.slice(0, 8)}`
}

/** The root folder of the run: the pinned cwd, or the git top once it is known. */
function rootPath(ctx: Pick<Ctx, 'facts'>): string | undefined {
  const root = ctx.facts.read('auto.root') as unknown as RootFact | null | undefined
  return root?.top ?? (typeof root?.cwd === 'string' ? root.cwd : undefined)
}

/**
 * The lookup caches and the queue live as long as the load (plan decision D16), so they are kept per load: the tracker is
 * a module constant (`TRACKERS`).
 */
type Services = { tracker: RepoTracker; queue: RepoQueue }
const loads = new LoadState<Services>()

export function reposTracker(): Tracker<ReposConfig, RepoRecord[]> & Traceable<RepoRecord[]> {
  /**
   * Queues a repo lookup and returns at once: a lookup costs several git calls and must not hold a tool result back.
   * Who, when and the generation are taken now, so the row says who touched the repo even when the job runs late. The
   * job writes nothing after `/track clear` or a new session (the generation moved). Never rejects.
   */
  function enqueue<T>(
    ctx: Ctx,
    key: string,
    items: readonly T[],
    label: (item: T) => string,
    agentId: string | undefined,
    resolve: (tracker: RepoTracker, item: T, who: string) => Promise<RepoVisit | null>,
  ): void {
    const live = loads.get(ctx)
    if (!live || items.length === 0) return
    const who = touchedBy(ctx, agentId)
    const at = ctx.clock.wall()
    const gen = ctx.generation
    const turn = ctx.turn // the job runs after the hook returned: the turn is read now, like the others
    // The turn is in the key: a burst of one turn is one write, but a visit of a later turn is a sighting that must not be lost.
    live.queue.push(`${key}\0${gen}\0${who}\0${turn?.ord ?? ''}\0${items.map(label).join('\0')}`, async () => {
      const visits: RepoVisit[] = []
      for (const item of items) {
        try {
          const v = await resolve(live.tracker, item, who)
          if (v) visits.push(v)
        } catch {
          // one bad item must not stop the others
        }
      }
      if (visits.length === 0) return
      let held: RepoRecord[] = []
      await setRepos(
        ctx,
        rows => {
          held = rows // the last run is the one that wrote: a write that missed its version runs again
          let out = rows
          for (const v of visits)
            out = upsertRepoRows(
              out,
              { ...v, at, ...(turn !== undefined ? { turn: turn.ord } : {}) },
              ctx.config.global().refresh.tickMs,
            )
          return out
        },
        gen,
      )
      // A job that ends after a session switch or `/track clear` wrote nothing, and tells the ledger nothing.
      if (turn !== undefined && ctx.generation === gen)
        await turn.note(repoSightings(turn.ord, visits, held, asRepoRows(await ctx.data.get())))
    })
  }

  const enqueuePaths = (ctx: Ctx, hits: readonly RepoHit[], agentId: string | undefined): void =>
    enqueue(
      ctx,
      'path',
      hits,
      h => `${h.mode}${h.branchMayChange ? '!' : ''}:${h.path}`,
      agentId,
      (t, h, who) => t.resolvePath(h.path, who, h.mode, { branchMayChange: h.branchMayChange === true }),
    )

  const enqueueRefs = (ctx: Ctx, refs: readonly RepoRef[], agentId: string | undefined): void =>
    enqueue(
      ctx,
      'ref',
      refs,
      r => `${r.host}/${r.owner}/${r.repo}`,
      agentId,
      (t, ref, who) => t.fromRepoRef(ref, who),
    )

  // A denied Bash call touched nothing. A failing one still did: `cd /x && false` has been there.
  const onBash: H<ToolCallEvent> = (ctx, ev) => {
    if (refused(ev.result)) return
    const command = String(isRecord(ev.input) ? (ev.input.command ?? '') : '')
    // The Bash input has no cwd. A relative `cd` or `git -C` needs a base: the cwd from before the command ran.
    const hints = parseRepoHintsFromBash(command, repoBaseDir(ev.cwdBefore, ev.agentId))
    enqueuePaths(ctx, hints.paths, ev.agentId)
    enqueueRefs(ctx, hints.repos, ev.agentId)
  }

  // A failed or denied file tool touched nothing. A subagent's relative path has no known base and is dropped.
  const onPathTool: H<ToolCallEvent> = (ctx, ev) => {
    if (failed(ev.result)) return
    enqueuePaths(ctx, extractRepoPathsFromTool(ev.tool, ev.input, repoBaseDir(ev.cwdBefore, ev.agentId)), ev.agentId)
  }

  // The cwd of a spawn. A nested child with no cwd of its own works where the ledger put it: in its parent's cwd.
  // The auto tracker records the spawn first (agentSpawn runs in `order`), so its fact holds the child's row.
  const onSpawn: H<AgentSpawnEvent> = (ctx, ev) => {
    const input = isRecord(ev.input) ? ev.input : undefined
    const answer = isRecord(ev.answer) ? ev.answer : undefined
    const agentId = str(answer?.agentId)
    if (agentId === undefined) return
    const cwd =
      str(input?.cwd) ??
      (str(input?.parentAgentId) !== undefined ? agentsOf(ctx).find(a => a.id === agentId)?.cwd : undefined)
    if (cwd) enqueuePaths(ctx, [{ path: cwd, mode: 'read' }], agentId)
  }

  // The dismiss list is the choke point: setRepos drops the row now that its id is on the list.
  const onDismissed: H<DismissedEvent> = (ctx, ev) => {
    if (!ev.ids.some(id => id.startsWith(repoRowId('')))) return
    return setRepos(ctx, rows => rows)
  }

  return {
    id: 'repos',
    order: 50,
    config: reposConfig,
    init: ctx => {
      // `run` is the raw runner of L3: it ignores the tool name, so `sh -c` (the env probe) goes through it too.
      // The queue size and the breaker are read once per load: they size an object at construction (C5). The git
      // timeout and the cache age are read at each use.
      const b = ctx.config.global().tools.breaker
      loads.of(ctx, () => ({
        tracker: new RepoTracker({
          run: (argv, o) => ctx.tools.run('git', argv, o ?? {}),
          now: () => ctx.clock.wall(),
          limits: () => ({ gitTimeoutMs: ctx.config.slice().gitTimeoutMs, tickMs: ctx.config.global().refresh.tickMs }),
          breakerLimits: b,
          get rootPath() {
            return rootPath(ctx)
          },
          get rootRepo() {
            return (ctx.facts.read('session.repo') as unknown as RepoRef | undefined) ?? null
          },
        }),
        queue: new RepoQueue(ctx.config.slice().maxRepoQueue),
      }))
    },
    store: ctx => ctx.config.slice(),
    data: {
      empty: v => !Array.isArray(v) || v.length === 0,
      settle: async (_ctx, live, stored) => mergeRepoRows(asRepoRows(stored), asRepoRows(live)),
      restore: async (ctx, value, how) => {
        const rows = asRepoRows(value)
        if (rows.length > 0)
          await setRepos(ctx, cur => (how === 'carry' ? mergeRepoRows(rows, cur) : mergeRepoRows(cur, rows)))
      },
      clear: ctx => setRepos(ctx, () => []),
    },
    sections,
    reasonsOf: repoReasonsOf,
    turnsOf: repoTurnsOf,
    events: {
      toolCall: { Bash: onBash, ...Object.fromEntries(PATH_TOOLS.map(tool => [tool, onPathTool])) },
      agentSpawn: onSpawn,
      dismissed: onDismissed,
    },
  }
}

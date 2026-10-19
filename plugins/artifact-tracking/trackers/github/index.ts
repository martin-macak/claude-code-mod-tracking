// The github tracker: GitHub issues and pull requests. It declares its identity, its config, its kind and its tool, `gh`,
// and it runs the PR lane (plan L5, Task 12; spec 5.9): the auto tracker publishes the fact `auto.branches` after each
// round, core tells this tracker when it changes, and the lane finds the PRs of those branches with one `gh` query. The
// state of the lane is the slot of this tracker. It is run-scoped (`persist: false`) like the slot of auto: it goes to
// `v2:run` and a session switch carries it.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7, 5.8 and 5.9. Plan: L3 Task 11, L5 Tasks 3, 8, 12.

import type { ConfigView } from '../../core/interfaces/config'
import type { CommandEvent, FactEvent } from '../../core/interfaces/events'
import type { Json, JsonObject } from '../../core/interfaces/items'
import type { Handler, Tracker, TrackerContext } from '../../core/interfaces/tracker'
import { LoadState } from '../../core/lib/load-state'
import { GH_TOOL, ghOf } from './client'
import { GITHUB_DEFAULTS, type GithubConfig, githubConfig } from './config'
import { githubKind } from './kind'
import { branchesOf, EMPTY_LANE, PrLane, wantsStep } from './lane'
import { githubPrompt } from './prompt'
import { parseRemote } from './remote'
import { foundRepo } from './repo'
import { sections } from './sections'
import type { DiscoveryApplied, DiscoveryTool, LaneState } from './types'

export { GH_TOOL, type GithubConfig, githubConfig, githubKind, parseRemote }

type Ctx = TrackerContext<GithubConfig, LaneState>
type H<E> = Handler<GithubConfig, LaneState, E>

/** The fact the auto tracker publishes after each round. This tracker reads it and imports nothing of auto. */
const FACT_BRANCHES = 'auto.branches'

/**
 * Changes the lane state. Every write goes through here. It reads first and stops when the change returns its input
 * (A22): a quiet step writes nothing. Else `update` runs the change on the current value and retries on a version miss.
 */
async function setLane(ctx: Pick<Ctx, 'data'>, change: (cur: LaneState) => LaneState): Promise<LaneState> {
  const cur = (await ctx.data.get()) ?? EMPTY_LANE
  if (change(cur) === cur) return cur
  return (await ctx.data.update(c => change(c ?? EMPTY_LANE))) ?? cur
}

/** The `gh` the lane asks, looked up at each call. A host that built no tools fails the step with `gh: not ready`, in the note, not at init. */
function discoveryOf(ctx: Ctx): DiscoveryTool {
  const tool = () => ghOf(ctx.tools, ctx.config as unknown as ConfigView<JsonObject>, () => ctx.clock.wall())
  const need = () => {
    const gh = tool()
    if (!gh) throw new Error('gh: not ready')
    return gh
  }
  return {
    get isAvailable() {
      return tool()?.isAvailable ?? false
    },
    canCall: now => need().canCall(now),
    status: () => need().status(),
    isHostAuthed: host => need().isHostAuthed(host),
    graphql: (host, query) => need().graphql(host, query),
  }
}

/** The lane of this load, over the context of the first hook: the same ports the item host and the auto round use. */
function laneOf(ctx: Ctx): PrLane {
  const gh = discoveryOf(ctx)
  const config = ctx.config as unknown as ConfigView<JsonObject>
  const repoCtx = {
    facts: ctx.facts,
    items: ctx.items,
    session: ctx.session,
    tools: ctx.tools,
    config,
    clock: ctx.clock,
  }
  return new PrLane({
    now: () => ctx.clock.wall(),
    load: async () => (await ctx.data.get()) ?? EMPTY_LANE,
    save: change => setLane(ctx, change),
    branches: () => branchesOf(ctx.facts.read<Json>(FACT_BRANCHES)),
    gh,
    ghReady: async () => {
      const tool = ghOf(ctx.tools, config, () => ctx.clock.wall())
      if (!tool) throw new Error('gh: not ready')
      await tool.probe()
      return tool.isAvailable
    },
    // The lookup the kind's `prepare` runs: the same one per session, so this waits for it and re-keys nothing.
    repo: () => foundRepo(repoCtx),
    // A bare `#N` in a PR body is an issue of the repo of that PR, so the fact `session.repo` is the PR's repo for the scan.
    scanBody: (text, repo) =>
      ctx.items.scan(text, { mode: 'full', purpose: 'lookup', facts: { 'session.repo': repo as unknown as Json } }),
    build: claim => ctx.items.build(claim),
    // The store runs the session check and reads the dismiss list, then calls `change` (maybe twice). The result of the
    // last call is what the lane reports.
    applyItems: async change => {
      let result: DiscoveryApplied | undefined
      await ctx.items.update((list, dismissed) => {
        result = change(list, dismissed)
        return result.list
      })
      if (!result) throw new Error('the item write did not run')
      return result
    },
    onAdded: keys => {
      if (keys.length > 0) ctx.items.refresh(keys)
    },
    lane: () => ({ ...GITHUB_DEFAULTS, ...ctx.config.slice() }),
    caps: () => {
      const g = ctx.config.global()
      return { staleMs: g.refresh.staleMs, maxItems: g.store.maxItems }
    },
  })
}

/** The lane of each load. A tracker is a module constant, so nothing per load sits in its closure. */
const loads = new LoadState<PrLane>()

/** A new `auto.branches` that opens the lane starts a step before `publish` returns; the step is not awaited. */
const onBranches: H<FactEvent> = (ctx, ev) => {
  const next = branchesOf(ev.value)
  if (next && wantsStep(next, branchesOf(ev.previous))) loads.get(ctx)?.request()
}

// `/track refresh` waits for the discovery too. Auto, order 10, has run its round by now, and its fact started the lane.
const onCommand: H<CommandEvent> = async (ctx, ev) => {
  if (ev.sub === 'refresh' && ev.wait) await loads.get(ctx)?.idle()
}

export function githubTracker(): Tracker<GithubConfig, LaneState> {
  return {
    id: 'github',
    order: 30,
    persist: false,
    config: githubConfig,
    kinds: [githubKind],
    tools: [GH_TOOL],
    init: ctx => {
      loads.of(ctx, () => laneOf(ctx))
    },
    store: ctx => ctx.config.slice(),
    data: {
      // A switch carries the lane state into the new state, as it carries the auto slot (L3 D9): it fills an empty slot
      // and never replaces a note a step wrote since.
      restore: async (ctx, value) => {
        if ((await ctx.data.get()) === undefined) await ctx.data.update(() => value)
      },
    },
    events: {
      facts: { [FACT_BRANCHES]: onBranches },
      command: onCommand,
    },
    sections,
    prompt: githubPrompt,
  }
}
